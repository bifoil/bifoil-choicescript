package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
)

// borrowedJSON keeps the framed payload alive without copying a potentially
// enormous didOpen/didChange body a second time. Each frame owns its buffer.
type borrowedJSON []byte

func (p *borrowedJSON) UnmarshalJSON(data []byte) error { *p = data; return nil }

type rpcMessage struct {
	sourceReadDone func()
	Sources        map[string]*textStore `json:"-"`
	JSONRPC        string                `json:"jsonrpc"`
	ID             json.RawMessage       `json:"id,omitempty"`
	Method         string                `json:"method,omitempty"`
	Params         borrowedJSON          `json:"params,omitempty"`
	Result         json.RawMessage       `json:"result,omitempty"`
	Error          *rpcError             `json:"error,omitempty"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return e.Message }

var cancelledRPC = &rpcError{-32800, "Request cancelled."}

type rpcStream struct {
	sourceReadStarted func() func()
	textDirectory     string
	captures          *captureOwner
	reader            *bufio.Reader
	writer            io.Writer
	mu                sync.Mutex
}

func newRPC(r io.Reader, w io.Writer) *rpcStream {
	return &rpcStream{reader: bufio.NewReader(r), writer: w, captures: &captureOwner{files: make(map[*os.File]struct{})}}
}
func (s *rpcStream) read() (rpcMessage, error) {
	var message rpcMessage
	length := -1
	headerBytes := 0
	for {
		line, err := s.reader.ReadString('\n')
		if err != nil {
			return message, err
		}
		headerBytes += len(line)
		if headerBytes > 16384 {
			return message, errors.New("RPC header is too large")
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			break
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			return message, errors.New("malformed RPC header")
		}
		if strings.EqualFold(key, "Content-Length") {
			if length >= 0 {
				return message, errors.New("duplicate RPC content length")
			}
			n, e := strconv.ParseInt(strings.TrimSpace(value), 10, 32)
			if e != nil || n < 0 {
				return message, errors.New("invalid RPC content length")
			}
			length = int(n)
		}
	}
	if length < 0 {
		return message, errors.New("missing RPC content length")
	}
	if length > 1024*1024 && s.textDirectory != "" {
		var done func()
		if s.sourceReadStarted != nil {
			done = s.sourceReadStarted()
		}
		message, err := s.readSourceFrame(length)
		if err != nil {
			if done != nil {
				done()
			}
		} else {
			message.sourceReadDone = done
		}
		return message, err
	}
	data := make([]byte, length)
	if _, err := io.ReadFull(s.reader, data); err != nil {
		return message, err
	}
	if err := json.Unmarshal(data, &message); err != nil {
		return message, err
	}
	if message.JSONRPC != "2.0" {
		return message, errors.New("expected JSON-RPC 2.0")
	}
	return message, nil
}
func (s *rpcStream) send(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err = fmt.Fprintf(s.writer, "Content-Length: %d\r\n\r\n", len(data)); err != nil {
		return err
	}
	_, err = s.writer.Write(data)
	return err
}
func (s *rpcStream) notify(method string, params any) error {
	return s.send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}
func (s *rpcStream) respond(id json.RawMessage, result any, err error) error {
	if err == nil {
		if tokens, ok := result.(semanticTokenResponse); ok {
			return s.respondTokens(id, tokens)
		}
	}
	response := map[string]any{"jsonrpc": "2.0", "id": id}
	if err != nil {
		failure := &rpcError{-32603, err.Error()}
		if errors.Is(err, context.Canceled) {
			failure = cancelledRPC
		}
		var coded *rpcError
		if errors.As(err, &coded) {
			failure = coded
		}
		response["error"] = failure
	} else {
		response["result"] = result
	}
	return s.send(response)
}

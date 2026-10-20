package core

import (
	"context"
	"io"
)

type cancelledParse struct{ cause error }

func (p *parser) poll() {
	if p.check != nil {
		if err := p.check(); err != nil {
			panic(cancelledParse{err})
		}
	}
}

// ParseSourceContext abandons obsolete parsing at lexical safe points. Ordinary
// syntax recovery remains unchanged; cancellation is an error, never a partial
// parse presented as a complete scene.
func ParseSourceContext(ctx context.Context, source Source) (parsed *ParsedSource, err error) {
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	defer func() {
		if value := recover(); value != nil {
			if cancelled, ok := value.(cancelledParse); ok {
				parsed = nil
				err = cancelled.cause
			} else {
				panic(value)
			}
		}
	}()
	parsed = new(ParsedSource)
	parsed.document = parseSourceChecked(source, 0, &parsed.names, &parsed.values, ctx.Err)
	return parsed, nil
}

type sourceReadFailure struct{ cause error }

// ParseSourceReaderContext consumes source once without retaining a whole-file
// string. Its detached result is identical to ParseSourceContext, including EOF
// rows, Unicode positions, syntax recovery and cancellation.
func ParseSourceReaderContext(ctx context.Context, identity Source, reader io.Reader, lineCapacity ...int) (parsed *ParsedSource, err error) {
	defer func() {
		if value := recover(); value != nil {
			switch failure := value.(type) {
			case cancelledParse:
				parsed = nil
				err = failure.cause
			case sourceReadFailure:
				parsed = nil
				err = failure.cause
			default:
				panic(value)
			}
		}
	}()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	count := 1024
	if len(lineCapacity) > 0 && lineCapacity[0] > 0 {
		count = lineCapacity[0]
	}
	parsed = new(ParsedSource)
	parsed.document = parseSourceLines(identity, 0, &parsed.names, &parsed.values, ctx.Err, count, physicalLines(reader, count))
	return parsed, nil
}

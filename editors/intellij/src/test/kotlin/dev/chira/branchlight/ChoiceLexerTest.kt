package dev.chira.branchlight
import org.junit.Assert.*
import org.junit.Test
class ChoiceLexerTest {
    @Test fun malformedCommandStringCannotConsumeNextLine() {
        val text="*set name \"broken\n*print 42"
        val lexer=ChoiceLexer();lexer.start(text,0,text.length,0)
        val tokens=mutableListOf<Pair<String,String>>()
        while(lexer.tokenType!=null){tokens.add(lexer.tokenType.toString() to text.substring(lexer.tokenStart,lexer.tokenEnd));lexer.advance()}
        assertTrue(tokens.contains("string" to "\"broken"));assertTrue(tokens.contains("keyword" to "*print"));assertTrue(tokens.contains("number" to "42"))
    }
    @Test fun proseQuotesDoNotCaptureCommands(){val text="She said \"hello\n*if male\n  William.\"";val lexer=ChoiceLexer();lexer.start(text,0,text.length,0);var found=false;while(lexer.tokenType!=null){if(text.substring(lexer.tokenStart,lexer.tokenEnd)=="*if")found=true;lexer.advance()};assertTrue(found)}
}

package dev.bifoil.choicescript

import com.google.gson.Gson
import com.intellij.codeInsight.template.TemplateActionContext
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.util.io.FileUtil
import com.intellij.psi.TokenType
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files
import java.nio.file.Path

/** Original presentation inputs exercise recognition, recovery and editor boundaries. */
class ChoicePresentationContractsTest : BasePlatformTestCase() {
	fun testRecognitionRejectsMalformedConfigurationAndUnrelatedFiles() {
		val cases = listOf(
			Triple("{}", "scenes/chapter.txt", true),
			Triple("{}", "notes.txt", false),
			Triple("""{"scenes":"chapters"}""", "chapters/CHAPTER.TXT", true),
			Triple("""{"scenes":null}""", "notes.txt", false),
			Triple("""{"scenes":true}""", "notes.txt", false),
			Triple("""{"scenes":[]}""", "notes.txt", false),
			Triple("{broken", "notes.txt", false),
			Triple("[]", "notes.txt", false),
			Triple("{}", "scenes/chapter.md", false),
			Triple("""{"scenes":"missing"}""", "notes.txt", false),
			Triple("""{"scenes":"/absolute"}""", "notes.txt", false),
			Triple(Gson().toJson(mapOf("scenes" to Path.of(".").toAbsolutePath().toString())), "notes.txt", false)
		)
		for ((config, name, expected) in cases) {
			val root = Files.createTempDirectory("bifoil recognition contract ")
			try {
				val scenes = Files.createDirectories(root.resolve(if ("chapters" in name) "chapters" else "scenes"))
				Files.writeString(scenes.resolve("startup.txt"), "Original start.")
				Files.writeString(root.resolve("choicescript.json"), config)
				val source = root.resolve(name)
				Files.writeString(source, "Original source.")
				val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(source)!!
				assertEquals("$config / $name", expected, ChoiceProjects.supports(project, file))
				assertEquals(expected, ChoiceSubstitutor().getLanguage(file, project) == ChoiceLanguage)
			} finally {
				FileUtil.delete(root.toFile())
			}
		}
		val explicit = myFixture.configureByText(ChoiceFileType, "Original standalone scene.")
		assertTrue(ChoiceProjects.supports(project, explicit.virtualFile))
	}

	fun testADirectoryNamedStartupDoesNotClaimUnrelatedTextFiles() {
		val root = Files.createTempDirectory("bifoil startup directory contract ")
		try {
			Files.createDirectory(root.resolve("startup.txt"))
			val source = Files.writeString(root.resolve("chapter.txt"), "Original unrelated text.")
			val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(source)!!
			assertFalse(ChoiceProjects.supports(project, file))
			assertNull(ChoiceSubstitutor().getLanguage(file, project))
		} finally {
			FileUtil.delete(root.toFile())
		}
	}

	fun testLexerRestartsAndTruncatedBuffersAlwaysMakeBoundedProgress() {
		val sources = listOf(
			"*print 0.0\n*set score 12.5 + 7\nOriginal prose.",
			"*if path\\name # Original unfinished input",
			"*if (name = \"quoted\\\"# text\") # Original option",
			"\t*print UPPER_19 + \u00e9\n\n\tOriginal final prose.\n",
			"*print \"unfinished\\\nOriginal recovery."
		)
		for (source in sources) {
			for (limit in 0..source.length) {
				for (initial in 0..limit) {
					val lexer = ChoiceLexer()
					lexer.start(source, initial, limit, 0)
					var offset = initial
					while (lexer.tokenType != null) {
						assertEquals("Restart $initial, limit $limit: $source", offset, lexer.tokenStart)
						assertTrue(lexer.tokenEnd in offset + 1..limit)
						offset = lexer.tokenEnd
						lexer.advance()
					}
					assertEquals(limit, offset)
				}
			}
		}
	}

	fun testIncompleteDecimalInputDoesNotConsumeTheFollowingIdentifier() {
		for ((source, expected) in listOf(
			"*print 1.z" to listOf("keyword" to "*print", "number" to "1", "operator" to ".", "variable" to "z"),
			"*print 1.5z" to listOf("keyword" to "*print", "number" to "1.5", "variable" to "z")
		)) {
			val lexer = ChoiceLexer()
			lexer.start(source, 0, source.length, 0)
			val actual = mutableListOf<Pair<String, String>>()
			while (lexer.tokenType != null) {
				if (lexer.tokenType != TokenType.WHITE_SPACE) {
					actual.add(lexer.tokenType.toString() to source.substring(lexer.tokenStart, lexer.tokenEnd))
				}
				lexer.advance()
			}
			assertEquals(source, expected, actual)
		}
	}

	fun testLexerMaintainsBoundedTokensAcrossEscapesNumbersAndInlineOptions() {
		val inputs = listOf(
			"*set total (TRUE and false) + 123.45 + 6. + _name2\r\nOriginal prose.",
			"*print \"escaped \\\" quote and \\\\ path\"\n*comment Original comment",
			"*print \"unfinished escape\\\r\nOriginal recovery.",
			"*if (name = \"not # prose\") # Visible option",
			"*selectable_if (total > 1) # Selectable option",
			"*hide_reuse# Reusable option",
			"*disable_reuse # Disabled option",
			"*allow_reuse # Repeated option",
			"*if (total > 1) #last",
			"*if (total > 1)#not-inline",
			"*if (total > 1)\n\t\nOriginal final prose.",
			"*if# Original adjacent option",
			"*if \"escaped \\\" quote\" # Original option",
			"*print .5 + 9e2 + value_ + trueValue",
			"*print \"trailing escape\\",
			"*if (flag) ) # Original malformed condition",
			"*print \"# still quoted\"",
			"*if (name = \"escaped \\\" # quoted\") # Good"
		)
		for (source in inputs) {
			val lexer = ChoiceLexer()
			lexer.start(source, 0, source.length, 0)
			assertEquals(source, lexer.bufferSequence.toString())
			assertEquals(source.length, lexer.bufferEnd)
			var offset = 0
			var steps = 0
			while (lexer.tokenType != null) {
				assertEquals(offset, lexer.tokenStart)
				assertTrue(lexer.tokenEnd in offset + 1..source.length)
				assertEquals(0, lexer.state)
				offset = lexer.tokenEnd
				steps++
				lexer.advance()
			}
			assertEquals(source.length, offset)
			assertTrue(steps <= source.length)
		}
		assertTrue(ChoiceHighlighter().getTokenHighlights(TokenType.WHITE_SPACE).isEmpty())
		assertNotNull(ChoiceHighlighterFactory().getSyntaxHighlighter(project, null).highlightingLexer)
		assertNull(ChoiceColors.key("unknown", emptyList()))
		assertNull(ChoiceColors.semanticKey("unknown", listOf("bold")))
		for (modifiers in listOf(emptyList(), listOf("bold"), listOf("italic"), listOf("bold", "italic"))) {
			assertNotNull(ChoiceColors.key("variable", modifiers))
		}
		assertNull(ChoiceColors.semanticKey("narrative", listOf("unrelated")))
		assertNotNull(ChoiceColors.semanticKey("narrative", listOf("italic")))
	}

	fun testEnterPreservesExistingTextAndTabIndentation() {
		for ((source, expected) in listOf(
			"first<caret>" to "first",
			"ordinary\n<caret>" to "ordinary\n",
			"*if true\nalready<caret>" to "*if true\nalready",
			"\t*if true\n<caret>" to "\t*if true\n\t\t",
			"  # Option\n <caret>" to "  # Option\n    "
		)) {
			val file = myFixture.configureByText(ChoiceFileType, source)
			WriteCommandAction.runWriteCommandAction(project) {
				ChoiceEnterHandler().postProcessEnter(file, myFixture.editor, DataContext.EMPTY_CONTEXT)
			}
			assertEquals(expected, myFixture.editor.document.text)
		}
		val file = myFixture.configureByText("unrelated.md", "*if true\n<caret>")
		WriteCommandAction.runWriteCommandAction(project) {
			ChoiceEnterHandler().postProcessEnter(file, myFixture.editor, DataContext.EMPTY_CONTEXT)
		}
		assertEquals("*if true\n", myFixture.editor.document.text)
		assertFalse(ChoiceTemplateContext().isInContext(TemplateActionContext.expanding(file, myFixture.editor)))
		val commenter = ChoiceCommenter()
		assertNull(commenter.blockCommentPrefix)
		assertNull(commenter.blockCommentSuffix)
		assertNull(commenter.commentedBlockCommentPrefix)
		assertNull(commenter.commentedBlockCommentSuffix)
	}
}

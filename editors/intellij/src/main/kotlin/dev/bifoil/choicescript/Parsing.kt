package dev.bifoil.choicescript

import com.intellij.extapi.psi.ASTWrapperPsiElement
import com.intellij.extapi.psi.PsiFileBase
import com.intellij.lang.ASTNode
import com.intellij.lang.ParserDefinition
import com.intellij.lang.PsiParser
import com.intellij.openapi.project.Project
import com.intellij.psi.FileViewProvider
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IFileElementType
import com.intellij.psi.tree.TokenSet

private val choiceFileElementType = IFileElementType(ChoiceLanguage)

/**
 * Minimal flat PSI for native editor actions; the shared server owns syntax and flow.
 * Consuming fallback tokens into a file node is intentional. Do not implement a second
 * indentation/expression parser here or infer cross-line dialogue from lexer state.
 */
class ChoiceParserDefinition : ParserDefinition {

	override fun createLexer(project: Project?) = ChoiceLexer()

	override fun createParser(project: Project?) = PsiParser { root, builder ->
		val file = builder.mark()
		while (!builder.eof()) builder.advanceLexer()
		file.done(root)
		builder.treeBuilt
	}

	override fun getFileNodeType() = choiceFileElementType

	override fun getWhitespaceTokens() = TokenSet.create(TokenType.WHITE_SPACE)

	override fun getCommentTokens() = TokenSet.create(ChoiceColors.tokens.getValue("comment"))

	override fun getStringLiteralElements() = TokenSet.create(ChoiceColors.tokens.getValue("string"))

	override fun createElement(node: ASTNode) = ASTWrapperPsiElement(node)

	override fun createFile(viewProvider: FileViewProvider) = object : PsiFileBase(viewProvider, ChoiceLanguage) {
		override fun getFileType() = ChoiceFileType
	}
}

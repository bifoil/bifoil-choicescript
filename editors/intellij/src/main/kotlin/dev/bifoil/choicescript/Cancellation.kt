package dev.bifoil.choicescript

import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import java.util.concurrent.CancellationException

/**
 * Recognize wrapped cancellation across CompletableFuture/LSP exception boundaries.
 * Cause traversal is bounded against pathological chains. Call sites must opt into this
 * classification; defining the helper alone does not change UI error handling.
 */
internal object GameToolCancellation {
	fun isCancellation(error: Throwable): Boolean = generateSequence(error) { it.cause }.take(16).any {
		it is CancellationException || (it is ResponseErrorException && it.responseError.code == -32800)
	}
}

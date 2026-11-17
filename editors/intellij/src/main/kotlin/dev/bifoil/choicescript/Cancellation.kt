package dev.bifoil.choicescript

import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture

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


/**
 * The platform's synchronous LSP API returns null for an exceptional future or
 * timeout. Carry the outcome as a normal result so failures remain distinct from
 * successful nullable replies. Forward platform cancellation to the wire request.
 */
internal fun <T> requestOutcome(request: CompletableFuture<T>): CompletableFuture<Result<T>> {
	val outcome = request.handle { value, error ->
		if (error == null) Result.success(value) else Result.failure<T>(error)
	}
	outcome.whenComplete { _, _ ->
		if (outcome.isCancelled) request.cancel(true)
	}
	return outcome
}

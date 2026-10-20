package dev.bifoil.choicescript

import junit.framework.TestCase
import org.eclipse.lsp4j.jsonrpc.Launcher
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class ChoiceNotificationTest : TestCase() {
	class Receiver : ChoiceClientNotifications {
		val received = CompletableFuture<ProjectsChangedParams>()

		override fun projectsChanged(params: ProjectsChangedParams) {
			received.complete(params)
		}

		override fun jobEvent(event: JobEvent) = Unit
	}

	fun testDiscoveryObjectIsDecodedThroughNativeJsonRpcReflection() {
		val body = """{"jsonrpc":"2.0","method":"choicescript/projectsChanged","params":{"protocolVersion":1,"projects":[{"id":"original","name":"Original Ω","root":"/original","sceneDir":"/original/scenes","assetDir":"/original"}]}}"""
		val payload = body.toByteArray(StandardCharsets.UTF_8)
		val input = ByteArrayInputStream(
			"Content-Length: ${payload.size}\r\n\r\n".toByteArray(StandardCharsets.US_ASCII) + payload
		)
		val receiver = Receiver()
		val launcher = Launcher.Builder<ChoiceClientNotifications>()
			.setLocalService(receiver)
			.setRemoteInterface(ChoiceClientNotifications::class.java)
			.setInput(input)
			.setOutput(ByteArrayOutputStream())
			.create()
		val listening = launcher.startListening()
		try {
			val result = receiver.received.get(5, TimeUnit.SECONDS)
			assertEquals(1, result.protocolVersion)
			assertEquals("Original Ω", result.projects.single().name)
			assertEquals("/original/scenes", result.projects.single().sceneDir)
		} finally {
			listening.cancel(true)
		}
	}
}

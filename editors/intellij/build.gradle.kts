import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode

plugins {
	kotlin("jvm") version "2.2.20"
	id("org.jetbrains.intellij.platform") version "2.19.0"
}
// Lock source/test library classpaths. IDE distributions and build tools have explicit pins below.
listOf("compileClasspath", "runtimeClasspath", "testCompileClasspath", "testRuntimeClasspath").forEach { name ->
	configurations.named(name) {
		resolutionStrategy.activateDependencyLocking()
	}
}
dependencyLocking {
	lockMode.set(LockMode.STRICT)
	// Product archives have their exact versions declared in intellijPlatform below.
	ignoredDependencies.addAll("idea:*", "webstorm:*", "pycharm:*", "com.jetbrains.intellij.platform:*")
}

group = "dev.bifoil.choicescript"
version = "0.1.0"
repositories {
	mavenCentral()
	intellijPlatform { defaultRepositories() }
}
dependencies {
	intellijPlatform {
		when (providers.gradleProperty("platformProduct").getOrElse("idea")) {
			"idea" -> intellijIdea("2026.1.4")
			"webstorm" -> webstorm("2026.1.4")
			"pycharm" -> pycharm("2026.1.4")
			else -> error("Unsupported platformProduct; choose idea, webstorm or pycharm")
		}
		testFramework(TestFrameworkType.Platform)
		pluginVerifier("1.410")
	}
	testImplementation("junit:junit:4.13.2")
}
kotlin {
	jvmToolchain(21)
	compilerOptions {
		jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
	}
}
intellijPlatform {
	pluginConfiguration {
		name = "Bifoil ChoiceScript"
		ideaVersion {
			sinceBuild = "261.26222"
		}
	}
	pluginVerification {
		ides {
			current()
		}
	}
}
tasks.test(Test::useJUnit)

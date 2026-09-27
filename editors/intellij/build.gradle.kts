plugins {
    kotlin("jvm") version "2.2.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}
group = "dev.chira.choicescripttools"
version = "0.1.0"
repositories { mavenCentral(); intellijPlatform { defaultRepositories() } }
dependencies {
    intellijPlatform { intellijIdea("2026.1.4"); testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform); pluginVerifier("1.410") }
    testImplementation("junit:junit:4.13.2")
}
kotlin { jvmToolchain(21) }
intellijPlatform {
    pluginConfiguration { name = "Branchlight - ChoiceScript Tools (Unofficial)"; ideaVersion { sinceBuild = "261.26222.65" } }
    pluginVerification { ides { current() } }
}
tasks.test { useJUnit() }

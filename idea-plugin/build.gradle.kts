plugins {
    java
    id("org.jetbrains.kotlin.jvm") version "2.1.20"
    id("org.jetbrains.intellij.platform") version "2.5.0"
}

group = "local.pannelhandle"
version = "0.1.0"
val localIdeaHome = providers.environmentVariable("PANNEL_HANDLE_IDEA_HOME").orNull

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    testImplementation("junit:junit:4.13.2")
    intellijPlatform {
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
        if (localIdeaHome.isNullOrBlank()) {
            intellijIdeaCommunity("2025.2.6.1")
        } else {
            local(localIdeaHome)
        }
    }
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    buildSearchableOptions = false
    pluginConfiguration {
        name = "Pannel Handle Bridge"
        version = project.version.toString()
        description = "Exposes IntelliJ IDEA Run and Debug configurations to Pannel Handle over an authenticated loopback bridge."
        ideaVersion {
            sinceBuild = "252"
            untilBuild = "252.*"
        }
        vendor {
            name = "Pannel Handle"
        }
    }
    pluginVerification {
        ides {
            if (!localIdeaHome.isNullOrBlank()) {
                local(file(localIdeaHome))
            }
        }
    }
}

tasks {
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
        }
    }
}

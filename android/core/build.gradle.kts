plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

// Sadece JDK 21 kurulu olabilir; toolchain indirmek yerine hedef sürümü 17 yapıyoruz
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}

application {
    mainClass.set("com.ortakizle.core.MainKt")
    applicationName = "ortak-izle-sunucu"
}

tasks.test {
    useJUnitPlatform()
}

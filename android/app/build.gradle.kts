plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.ortakizle.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.ortakizle.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 5
        versionName = "2.3.0"
    }

    // Her makinede aynı anahtar: farklı bilgisayarlardan çıkan APK'lar birbirini güncelleyebilsin
    signingConfigs {
        create("release") {
            storeFile = file("ortakizle-release.jks")
            storePassword = "ortakizle-kardesler"
            keyAlias = "ortakizle"
            keyPassword = "ortakizle-kardesler"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    // Arayüz dosyaları depodaki tek kaynaktan (web/) kopyalanır
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
}

val copyWebAssets by tasks.registering(Sync::class) {
    from(rootProject.file("../web"))
    into(layout.buildDirectory.dir("generated/webAssets/web"))
}
tasks.named("preBuild") { dependsOn(copyWebAssets) }

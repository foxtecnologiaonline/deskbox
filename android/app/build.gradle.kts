plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.deskbox.phone"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.deskbox.phone"
        minSdk = 26
        targetSdk = 34
        // No workflow Release vêm da tag (vX.Y.Z) e do número da execução — o Android exige versionCode crescente.
        versionCode = System.getenv("DESKBOX_VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = System.getenv("DESKBOX_VERSION") ?: "0.1.0"

        // libwebrtc traz libs nativas por ABI (~15 MB cada). Só ARM: é o que os celulares usam (64 bits nos atuais,
        // 32 bits nos antigos/baratos). x86/x86_64 é emulador — fora do APK de produção.
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    // .so comprimidas dentro do APK: o download (APK avulso, fora da Play Store) cai quase pela metade; o Android
    // extrai na instalação. Sem isso as libs vão sem compressão (otimização que só compensa na Play Store).
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    // Chave própria (segredo ANDROID_KEYSTORE_BASE64 no CI): mesma assinatura em todas as versões, então o
    // Android aceita instalar a nova por cima. Sem ela o CI gera APK de debug (cada build com outra chave).
    signingConfigs {
        val keystore = System.getenv("ANDROID_KEYSTORE_FILE")
        if (!keystore.isNullOrBlank()) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("io.github.webrtc-sdk:android:125.6422.07")
}

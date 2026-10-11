package com.ortakizle.core

import java.io.File

// Web arayüzü dosyalarını sağlayan kaynak. Yol başında "/" olmadan gelir: "index.html", "fonts/x.woff2"
fun interface AssetSource {
    fun open(path: String): ByteArray?
}

// Bir klasörden dosya okur; klasör dışına çıkmaya (../) izin vermez
class DirectoryAssetSource(dir: File) : AssetSource {
    private val root: File = dir.canonicalFile

    override fun open(path: String): ByteArray? {
        if (path.isEmpty() || path.contains('\u0000') || path.contains('\\')) return null
        if (path.split('/').any { it == ".." }) return null
        return try {
            val file = File(root, path).canonicalFile
            if (!file.path.startsWith(root.path + File.separator)) return null
            if (!file.isFile) return null
            file.readBytes()
        } catch (e: Exception) {
            null
        }
    }
}

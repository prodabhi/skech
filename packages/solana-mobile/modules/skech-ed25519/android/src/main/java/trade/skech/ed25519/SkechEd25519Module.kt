package trade.skech.ed25519

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec

/*
  Ed25519 signing from the platform's own crypto (Conscrypt has it from Android 13): what a whole OpenSSL used to
  ship in the app for. Below Android 13 `available` is false and the app signs in JavaScript.
*/
class SkechEd25519Module : Module() {
  private var key: PrivateKey? = null

  override fun definition() = ModuleDefinition {
    Name("SkechEd25519")

    Function("available") { Build.VERSION.SDK_INT >= 33 }

    // The 32-byte seed, wrapped as PKCS#8 (RFC 8410), which is the only form KeyFactory takes.
    Function("load") { seed: ByteArray ->
      require(seed.size == 32) { "an Ed25519 seed is 32 bytes" }
      key = KeyFactory.getInstance("Ed25519").generatePrivate(PKCS8EncodedKeySpec(PKCS8_PREFIX + seed))
    }

    Function("sign") { message: ByteArray ->
      val signer = Signature.getInstance("Ed25519")
      signer.initSign(key ?: error("no key loaded"))
      signer.update(message)
      signer.sign()
    }
  }

  companion object {
    private val PKCS8_PREFIX = byteArrayOf(
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    )
  }
}

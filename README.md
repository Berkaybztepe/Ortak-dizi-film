# 🎬 Ortak İzle

Kardeşinle (ya da herhangi biriyle) **aynı anda** dizi/film izlemek için küçük bir uygulama.

- ⏯ **Ortak oynat / durdur / sar** — biriniz durdurunca diğerinde de durur, biriniz sarınca diğeri de aynı saniyeye gider.
- 🔄 **Kayma düzeltmesi** — biri internet yüzünden geride kalırsa birkaç saniye içinde otomatik yakalar.
- 💬 **Sohbet** — dizinin üstünde açılan küçük panelden mesajlaşma (tam ekranda da çalışır).
- 👀 **Kim ne açtı** — biriniz bir bölüm açınca diğerine "Berkay *Loki* açtı — **Ben de aç**" bildirimi gelir. İstersen otomatik geçiş de açılabilir.
- 📣 **Buraya çağır** — açtığın bölümü tek tuşla diğerine gönder.
- Desteklenen platformlar: **Disney+**, **HBO Max**, **Apple TV+**, ayrıca Netflix, Prime Video ve YouTube.

## Nasıl çalışıyor?

```
   Senin tarayıcın                     Tablet (sunucu)                 Kardeşinin tarayıcısı
 ┌──────────────────┐   oynat/durdur  ┌────────────────┐  oynat/durdur ┌──────────────────┐
 │ Disney+ sekmesi  │ ──────────────► │  server.js     │ ────────────► │ Disney+ sekmesi  │
 │ + Ortak İzle     │ ◄────────────── │  (oda, sohbet) │ ◄──────────── │ + Ortak İzle     │
 │   eklentisi      │      sohbet     └────────────────┘     sohbet    │   eklentisi      │
 └──────────────────┘                                                  └──────────────────┘
```

**Görüntü sunucudan geçmez.** Disney+, HBO Max gibi servisler videoyu şifreli (DRM) gönderir, başka bir yere
yayınlanamaz. Bu yüzden ikiniz de kendi cihazınızda, ortak hesabınızla normal şekilde giriş yapıp izlersiniz;
uygulama sadece kumandayı ve sohbeti eşitler. Bu sayede görüntü kalitesi düşmez ve tablete yük binmez.

Klasörler:

| Klasör | Ne işe yarar |
|---|---|
| `server/` | Tablette çalışan sunucu. Hiçbir paket kurmak gerekmez, sadece Node.js. Ayrıca `http://tablet-adresi:8787` adresinde sohbet paneli sunar. |
| `extension/` | İkinizin de tarayıcısına kurulan eklenti (Chrome, Edge, Brave, Opera, Firefox). |

---

## 1) Sunucuyu tablette çalıştır (Android)

1. Play Store'daki eski sürüm değil, **F-Droid**'den **Termux**'u kur: <https://f-droid.org/packages/com.termux/>
2. Termux'u aç ve şunları yaz:
   ```sh
   pkg update -y && pkg install -y nodejs git
   git clone https://github.com/berkaybztepe/ortak-dizi-film.git
   cd ortak-dizi-film/server
   node server.js
   ```
3. Ekranda şöyle bir şey göreceksin:
   ```
   Ortak İzle sunucusu çalışıyor 🎬
   Bu cihazda:      http://localhost:8787
   Aynı Wi-Fi'da:   http://192.168.1.20:8787
   ```
   `192.168.1.20:8787` kısmı **sunucu adresin**. Eklentiye bunu yazacaksınız.

İpuçları:
- Termux arka plandayken Android uygulamayı uyutmasın diye bildirimden **"Acquire wakelock"**'a dokun.
- Şifre koymak istersen: `ODA_SIFRE=gizli123 node server.js`
- Port değiştirmek için: `PORT=9000 node server.js`
- Sonraki seferlerde sadece `cd ortak-dizi-film/server && node server.js` yeterli. Güncellemek için `git pull`.

> Bilgisayarda çalıştırmak da aynı: Node.js 18+ kur, `server` klasöründe `node server.js`.
> (Windows'ta ilk açılışta güvenlik duvarı sorarsa **İzin ver** de.)

## 2) Farklı evlerdeyseniz: Tailscale (ücretsiz)

Aynı Wi-Fi'daysanız bu adımı atla. Farklı evlerdeyseniz kardeşinin tablete ulaşabilmesi gerekir. En kolay ve
güvenli yol **Tailscale**: modem ayarı, port açma gerektirmez.

1. Tablete ve ikinizin bilgisayarına **Tailscale** uygulamasını kurun (<https://tailscale.com/download>).
2. Hepsinde **aynı hesapla** giriş yapın (kardeşini kendi ağına davet de edebilirsin: Tailscale yönetim panelinde *Share*).
3. Tailscale uygulamasında tabletin adresi görünür, `100.x.y.z` gibi. Sunucu adresi: `100.x.y.z:8787`

Alternatif: `cloudflared tunnel --url http://localhost:8787` (Termux'ta `pkg install cloudflared`) sana
`https://...trycloudflare.com` gibi bir adres verir; eklentiye onu yazabilirsiniz. Bu adres herkese açık olduğu için
bu durumda **mutlaka `ODA_SIFRE` koy**.

## 3) Eklentiyi ikinizin tarayıcısına kur

Önce bu depoyu indirin (GitHub'da **Code → Download ZIP**) ve zip'i açın.

**Chrome / Edge / Brave / Opera (bilgisayar):**
1. Adres çubuğuna `chrome://extensions` yaz (Edge'de `edge://extensions`).
2. Sağ üstten **Geliştirici modu**'nu aç.
3. **Paketlenmemiş öğe yükle** → `extension` klasörünü seç.
4. Yapboz simgesinden **Ortak İzle**'yi sabitle.

**Firefox (bilgisayar):** `about:debugging#/runtime/this-firefox` → **Geçici eklenti yükle** → `extension/manifest.json`.
(Firefox imzasız eklentiyi kapanınca siler; kalıcı kullanım için Chrome/Edge daha pratik.)

## 4) Kullanım

1. Eklenti simgesine tıkla:
   - **Sunucu adresi:** tabletin adresi (ör. `192.168.1.20:8787` veya `100.x.y.z:8787`)
   - **Adın:** ör. *Berkay*
   - **Oda adı:** ikiniz de aynısını yazın (ör. *salon*)
   - **Bağlan**'a bas. Yeşil nokta = bağlı.
2. Disney+ / HBO Max / Apple TV+'ya ortak hesabınızla **normal şekilde giriş yapın** (bir kere yapmanız yeterli,
   tarayıcı hatırlar).
3. Biriniz bölümü açsın. Diğerine **"… açtı — Ben de aç"** bildirimi gelir, tıklayınca aynı bölüme gider ve
   **aynı saniyeye atlar**.
4. Artık biriniz durdurunca / oynatınca / sarınca diğerinde de olur. Sağ alttaki **💬** düğmesi sohbeti açar.
   - **⟲ Senkronla:** bir şey ters giderse diğerinin kaldığı yere atlar.
   - **📣 Buraya çağır:** açık olan sayfayı diğerine gönderir.
5. Tabletten (veya telefondan) sadece sohbet etmek ve kimin ne izlediğini görmek için tarayıcıda sunucu adresini aç:
   `http://192.168.1.20:8787`

## Bilmen gerekenler

- **Eşzamanlı izleme sınırı:** Aynı hesaptan iki cihazda izleyebilmek için paketinizin buna izin vermesi lazım
  (Disney+ Standart/Premium ve HBO Max Standart/Premium paketleri 2+ ekrana izin veriyor; en ucuz paketlerde
  sınır olabilir). Disney+ ve HBO Max, hesabın farklı evlerde kullanılmasını da kısıtlamaya başladı;
  "hane dışı" uyarısı çıkarsa bu uygulamayla ilgili değil, platformun kuralı.
- **Reklamlı paketler:** Reklam arası iki tarafta farklı zamanda gelebilir. Reklam bitince **⟲ Senkronla**'ya bas.
- **Tarayıcı otomatik oynatmayı engellerse** ekranda "Başlatmak için dokun" çıkar, bir kere dokunman yeterli.
- **Telefon/tablet uygulamaları** (Disney+ Android uygulaması gibi) kontrol edilemez; izleyen cihazlarda
  platformların **web sitesi** + bu eklenti kullanılmalı. Android'de eklenti destekleyen tarayıcılar
  (ör. Firefox Nightly, Edge Canary) ile çalışabilir ama en sorunsuz deneyim bilgisayardadır.
- Platformlar sitelerini değiştirirse video bulma kısmı bozulabilir; `extension/content.js` içinde
  `pickVideo()` fonksiyonu bütün `<video>` öğelerini (gölge DOM dahil) tarar, genelde ek ayar gerekmez.

## Geliştirici notları

- Sunucu testleri: `cd server && npm test` (Node 22+).
- Sunucu protokolü (JSON, WebSocket `/ws`): `join`, `chat`, `sync` (play/pause/seek), `tick` (oynarken 4 sn'de bir konum,
  sadece son kumanda edenden kabul edilir), `nav` (açılan sayfa), `invite`, `ping`/`pong` (saat eşitleme).
- Yeni bir platform eklemek için `extension/manifest.json` → `content_scripts.matches` listesine adresini ekle.

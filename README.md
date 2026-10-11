# Ortak İzle

Kardeşinle aynı anda, aynı saniyede dizi ve film izlemek için bir Android uygulaması ve bilgisayar eklentisi.

- **Ortak kumanda:** biriniz oynatınca, durdurunca ya da sarınca diğerinde de olur. Durunca ikiniz de aynı karede durursunuz.
- **Bekleme:** birinin interneti takılıp video yüklenirken diğeri otomatik bekler, yükleme bitince ikiniz birlikte devam edersiniz.
- **3-2-1 başlat:** ekranın ortasında geri sayım çıkar, ikinizde aynı anda başlar.
- **Kayma düzeltmesi:** biri birkaç saniye geride kalırsa kendiliğinden yakalar.
- **Sohbet ve tepkiler:** izlerken mesajlaşırsınız; 😂 🔥 gibi tepkiler karşı tarafın videosunun üstünde uçar.
- **Kim ne açtı:** biriniz bir bölüm açınca diğerine "Berkay *Loki* açtı · **Sen de aç**" bildirimi gelir. Tek dokunuşla aynı bölüme ve aynı saniyeye gidersin.
- **Oda tablette:** sunucu uygulamanın içinde. Ayrı bir program kurmak gerekmez. Aynı Wi-Fi'daki cihazlar odayı kendiliğinden bulur.

## Nasıl çalışıyor?

Görüntü bir cihazdan diğerine aktarılmaz. Disney+, HBO Max gibi servisler videoyu şifreli (DRM) gönderir ve başka bir yere yayınlanmasına izin vermez. Bu yüzden ikiniz de ortak hesabınızla kendi cihazınızda izlersiniz. Ortak İzle sadece kumandayı, sohbeti ve "kim nerede" bilgisini eşitler. Bu sayede görüntü kalitesi düşmez, tablete de yük binmez.

```
 Tablet (odayı açan)                         Kardeşin
┌──────────────────────────┐   oynat/durdur  ┌──────────────────────────┐
│ Ortak İzle uygulaması    │ ◄─────────────► │ Ortak İzle uygulaması    │
│  ├ oda sunucusu (8787)   │   sohbet, tepki │   ya da bilgisayarda     │
│  └ Disney+ / HBO Max …   │                 │   Ortak İzle eklentisi   │
└──────────────────────────┘                 └──────────────────────────┘
```

## Hangi platformda nerede çalışır?

| Platform | Android uygulaması | Bilgisayar eklentisi (Chrome/Edge) |
|---|---|---|
| Disney+ | Çalışır (masaüstü görünümüyle, bkz. not 1) | Çalışır |
| HBO Max | Çalışır (masaüstü görünümüyle, bkz. not 1) | Çalışır |
| Apple TV+ | Çalışır | Çalışır |
| Prime Video | Çalışır (bkz. not 1) | Çalışır |
| YouTube | Çalışır (denemek için en kolayı) | Çalışır |
| Netflix | **Çalışmaz** (Netflix uygulama içi tarayıcıda oynatmaya izin vermiyor) | Çalışır |
| Exxen, TOD, Gain, tabii ve diğerleri | "Başka site" kutusuna adresini yaz | Exxen, TOD, Gain, tabii eklentide hazır |

**Not 1:** Disney+ ve HBO Max telefon ve tabletler için resmi olarak kendi uygulamalarını öneriyor. Ortak İzle siteyi "masaüstü görünümünde" açarak web oynatıcısını kullanır. Bu çoğu cihazda çalışır, ama görüntü kalitesi cihaza göre 480p–720p ile sınırlı kalabilir. Bir platform tablette hiç açılmazsa en garantili yol bilgisayarda eklentiyi kullanmaktır. Uygulama ile eklenti aynı odada birlikte çalışır: biriniz tabletten, diğeriniz bilgisayardan izleyebilir.

---

## 1. Uygulamayı kur (Android)

1. Bu depodaki [`dist/OrtakIzle.apk`](dist/OrtakIzle.apk) dosyasını tablete ve kardeşinin telefonuna/tabletine indir.
   GitHub'da dosyaya tıkla, sonra **Download raw file** (indir) düğmesine bas.
2. Dosyayı aç. Android "bilinmeyen kaynaklardan yükleme" izni isterse, açtığın uygulamaya (Chrome ya da Dosyalar) izin ver.
3. **Ortak İzle** uygulamasını aç ve adını yaz.

> Android 8.0 ve üstü gerekir. Uygulama güncellemesi için yeni APK'yı aynı şekilde kurman yeterli; ayarlar ve girişler silinmez.

## 2. Odayı tablette aç

1. Tablette **Odayı burada aç**'a dokun. Uygulama bildirim izni isterse ver; oda açıkken bildirimde kimlerin bağlı olduğu görünür.
2. Ekrandaki bilette tabletin adresi yazar, örneğin `192.168.1.20:8787`.
3. **Aynı Wi-Fi'daysanız:** kardeşinin uygulamasında "Bir odaya katıl" altında oda kendiliğinden görünür. Dokunması yeterli.
4. **Farklı evlerdeyseniz:** aşağıdaki Tailscale adımına bak. Adresi **Adresi gönder** düğmesiyle WhatsApp'tan yollayabilirsin.

Oda, uygulama arka plandayken de açık kalır. Kapatmak için biletteki **Odayı kapat**'a ya da bildirimdeki **Odayı kapat**'a dokun.

## 3. Farklı evlerdeyseniz: Tailscale (ücretsiz, 5 dakika)

İki cihazın birbirini internet üzerinden bulabilmesi için en kolay ve güvenli yol Tailscale. Modemde ayar yapmak gerekmez.

1. Tablete ve kardeşinin cihazına Play Store'dan **Tailscale** uygulamasını kur.
2. İkisinde de **aynı hesapla** giriş yap. Kardeşinin kendi hesabını kullanmasını istersen Tailscale yönetim panelinden tableti onunla paylaşabilirsin (*Share*).
3. Tailscale açıkken tablette odayı aç. Bilette bir de **Tailscale** adresi çıkar (`100.x.y.z:8787`).
4. Kardeşin "Bir odaya katıl" kutusuna bu adresi yazıp **Katıl**'a bassın.

## 4. Birlikte izleme

1. Salonda platformu seç (örneğin **Disney+**). İlk seferde ortak hesabınla bir kez giriş yap; uygulama girişi hatırlar.
2. Bir bölüm aç. Kardeşine "Berkay Loki açtı · **Sen de aç**" bildirimi gider; dokununca aynı bölümde, aynı saniyede açılır.
3. Artık videonun kendi düğmeleriyle oynat, durdur, sar. Hepsi ikinizde birden olur.
4. Panelde:
   - **Senkronla:** bir şey ters giderse diğerinin kaldığı yere atlar.
   - **3-2-1 başlat:** geri sayımla birlikte başlatır.
   - **Buraya çağır:** açtığın bölümü diğerine gönderir.
   - Altta sohbet ve tepkiler.
5. Yatay tutunca video solda, panel sağda olur. Paneli gizleme düğmesiyle video tam ekrana geçer; sağ üstte küçük bir sohbet düğmesi kalır, mesajlar bildirim olarak görünür. Dikeyde video üstte, panel altta durur.

Ayarlar (sağ üstteki dişli):
- **Diğeri bir şey açınca beni de götür:** bildirim beklemeden otomatik geçer.
- **Masaüstü görünümü:** Disney+ ve HBO Max için açık kalmalı.
- **İzlerken ekranı açık tut.**
- **Oda şifresi:** odayı açan kişi şifre koyarsa katılanlar da aynısını yazar.

## 5. Bilgisayardan katılmak (Chrome / Edge eklentisi)

1. Depoyu indir: GitHub'da **Code → Download ZIP**, sonra zip'i aç.
2. Chrome'da `chrome://extensions` (Edge'de `edge://extensions`) adresini aç ve sağ üstten **Geliştirici modu**'nu aç.
3. **Paketlenmemiş öğe yükle**'ye tıkla ve `extension` klasörünü seç. Yapboz simgesinden **Ortak İzle**'yi sabitle.
4. Simgeye tıkla, tabletteki adresi, adını ve oda adını (`salon`) yaz, **Bağlan**'a bas.
5. Disney+ / HBO Max / Netflix sekmesinde sağ alttaki yuvarlak düğme sohbet ve kumanda panelini açar.

Firefox'ta: `about:debugging#/runtime/this-firefox` → **Geçici eklenti yükle** → `extension/manifest.json`. Firefox bu tür eklentiyi kapanınca kaldırır; kalıcı kullanım için Chrome veya Edge daha pratik.

## 6. Web paneli

Odanın adresini herhangi bir tarayıcıda açarsan (`http://192.168.1.20:8787`) sohbet ve "kim ne izliyor" ekranı gelir. Televizyonda izlerken telefondan mesajlaşmak ve tepki göndermek için kullanışlı. Bu panel videoyu kontrol etmez.

## Sorun giderme

| Ne oluyor? | Ne yapmalı? |
|---|---|
| Kardeşim odayı listede görmüyor | Aynı Wi-Fi'da olduğunuzdan emin ol. Bazı modemler cihazların birbirini görmesini engeller ("misafir ağı" ya da "AP isolation"); o durumda adresi elle yazın ya da Tailscale kullanın. |
| "Sunucuya ulaşılamadı" | Tabletin ekranı uzun süre kapalıyken bazı telefon üreticileri uygulamaları uyutur. Ayarlar → Uygulamalar → Ortak İzle → Pil → **Kısıtlama yok** seç. |
| Disney+ / HBO Max "desteklenmeyen tarayıcı" diyor | Ayarlarda **Masaüstü görünümü** açık mı? Açıksa o cihazda web oynatıcısı desteklenmiyor demektir; bilgisayarda eklentiyle izleyin. |
| "Bu hesapta çok fazla cihaz izliyor" | Paketiniz aynı anda kaç ekrana izin veriyorsa o kadar kişi izleyebilir (Disney+ ve HBO Max'in standart paketleri 2 ekran). |
| Reklam arası iki tarafta farklı zamanda geldi | Reklam bitince **Senkronla**'ya dokunun. |
| "Oynatmak için dokun" yazısı çıkıyor | Tarayıcı sesli videonun kendiliğinden başlamasını engelledi; bir kez dokunmak yeterli. |
| Netflix uygulamada açılmıyor | Netflix buna izin vermiyor; bilgisayarda eklentiyle izleyin. |

## Proje yapısı

| Klasör | İçerik |
|---|---|
| `android/` | Android uygulaması (Kotlin). `core/` modülü oda sunucusudur, uygulamanın içinde çalışır. |
| `web/` | Uygulamanın arayüzü (HTML/CSS/JS), oda istemcisi ve dizi sitelerine eklenen senkron motoru. Uygulama, eklenti ve web paneli hepsi bunu kullanır. |
| `extension/` | Chrome / Edge / Firefox eklentisi. `extension/shared/` içeriği `web/`'den kopyalanır. |
| `server/` | Aynı sunucunun Node.js sürümü (isteğe bağlı: odayı bir bilgisayarda açmak için `node server/server.js`). |
| `tests/` | Uçtan uca testler (iki tarayıcıyla gerçek senkron denemesi). |
| `dist/` | Hazır APK. |

### Geliştirme

```sh
npm test                      # sunucu protokol testleri + ortak dosyaların güncelliği
npm install && npm run test:e2e   # iki Chromium ile uçtan uca testler (ffmpeg gerekir)
node tools/sync-shared.mjs    # web/ değişince eklentideki kopyaları güncelle

cd android
./gradlew :core:test :app:assembleRelease   # APK: app/build/outputs/apk/release/app-release.apk
```

- Kotlin sunucusu Node sunucusuyla aynı protokolü konuşur ve aynı testten geçer: `ODA_SIFRE=gizli PORT=8790 ASSETS_DIR=$PWD/web android/core/build/install/ortak-izle-sunucu/bin/ortak-izle-sunucu` ile başlat, sonra `cd server && TEST_PORT=8790 node test.js`.
- GitHub'a her gönderimde `.github/workflows/build.yml` testleri çalıştırır ve APK'yı derler (Actions → son çalışma → **OrtakIzle-apk**).
- Protokol (WebSocket `/ws`, JSON): `join`, `chat`, `sync` (play/pause/seek), `tick` (oynarken 4 sn'de bir konum; yalnızca son kumanda edenden kabul edilir), `nav`, `invite`, `react`, `typing`, `buffer`, `countdown`, `ping`/`pong` (saat eşitleme).

# Ortak İzle

Kardeşinle aynı anda, aynı saniyede dizi ve film izlemek için bir Android uygulaması ve bilgisayar eklentisi.

- **Tek video gibi:** biriniz oynatınca ikiniz aynı anda başlarsınız (fark onda bir saniyenin altında), durdurunca ikiniz de aynı karede durursunuz, sarınca ikiniz de aynı sahneye gidersiniz.
- **Sessiz düzeltme:** biri takılıp geride kalırsa video fark ettirmeden azıcık hızlanıp yetişir; büyük farkta kendiliğinden sarar.
- **Bekleme:** birinin interneti takılıp video yüklenirken diğeri otomatik bekler, yükleme bitince ikiniz birlikte devam edersiniz.
- **3-2-1 başlat:** ikiniz de durur, aynı kareye gelir, geri sayımla aynı anda başlarsınız.
- **Yönetici:** odayı açan kişi bölümü seçer; diğeri kendiliğinden aynı bölüme geçer, başka bölüm açamaz, bölümden çıkamaz (Ayarlar'dan kapatılabilir).
- **Biri çıkarsa video durur:** biriniz bölümden ya da odadan çıkınca (kazara bile) video ikinizde de durur ve ekranda uyarı çıkar.
- **Sohbet ve tepkiler:** izlerken mesajlaşırsınız; sohbet kapalıyken gelen mesajlar videonun altından akar, 😂 🔥 gibi tepkiler karşı tarafın videosunun üstünde uçar.
- **Kendini günceller:** yeni sürüm çıkınca ana ekranda "Güncelle" kartı çıkar; eskisini silmeden üstüne kurulur.
- **Kim ne açtı:** biriniz bir bölüm açınca diğerine "Berkay *Loki* açtı · **Sen de aç**" bildirimi gelir. Tek dokunuşla aynı bölüme ve aynı saniyeye gidersin.
- **Oda kodu:** tablet odayı açınca `K7M-4QX` gibi bir kod verir. Kardeşin başka şehirde bile olsa bu kodu bir kez yazar; sonraki seferlerde uygulama kendiliğinden bağlanır. Hesap, şifre ya da ek uygulama gerekmez.

## Nasıl çalışıyor?

Görüntü bir cihazdan diğerine aktarılmaz. Disney+, HBO Max gibi servisler videoyu şifreli (DRM) gönderir ve başka bir yere yayınlanmasına izin vermez. Bu yüzden ikiniz de ortak hesabınızla kendi cihazınızda izlersiniz. Ortak İzle sadece kumandayı, sohbeti ve "kim nerede" bilgisini eşitler. Bu sayede görüntü kalitesi düşmez, tablete de yük binmez.

```
 Tablet (odayı açan)                                     Kardeşin (başka ev)
┌──────────────────────────┐   şifreli mesajlar   ┌──────────────────────────┐
│ Ortak İzle uygulaması    │ ◄──── aracı ───────► │ Ortak İzle uygulaması    │
│  ├ oda sunucusu          │   (oda kodu ile)     │   ya da bilgisayarda     │
│  └ Disney+ / HBO Max …   │                      │   Ortak İzle eklentisi   │
└──────────────────────────┘                      └──────────────────────────┘
```

Farklı evlerdeki iki cihazın birbirini bulması için mesajlar ücretsiz ve herkese açık "aracı" sunucular (EMQX, HiveMQ, Mosquitto MQTT sunucuları) üzerinden gider. Uygulama üçüne birden bağlanır; biri çalışmazsa diğeri kullanılır. Her mesaj oda kodundan türetilen anahtarla **şifrelenir** (AES-256-GCM): aracı sunucular ne yazdığınızı, ne izlediğinizi göremez. Görüntü bu yoldan geçmez, yalnızca küçük kumanda mesajları geçer.

## Hangi platformda nerede çalışır?

| Platform | Android uygulaması | Bilgisayar eklentisi (Chrome/Edge) |
|---|---|---|
| Disney+ | Çalışır (masaüstü görünümüyle, bkz. not 1) | Çalışır |
| HBO Max | Çalışır (masaüstü görünümüyle, bkz. not 1) | Çalışır |
| Apple TV+ | Çalışır | Çalışır |
| Prime Video | Çalışır (bkz. not 1) | Çalışır |
| YouTube | Çalışır (denemek için en kolayı) | Çalışır |
| Netflix | Denenebilir: telefonda web oynatıcıyı çoğunlukla engelliyor; engellerse uygulama bunu açıkça söyler | Çalışır |
| Exxen, TOD, Gain, tabii ve diğerleri | "Başka site" kutusuna adresini yaz | Exxen, TOD, Gain, tabii eklentide hazır |

**Not 1:** Disney+ ve HBO Max telefon ve tabletler için resmi olarak kendi uygulamalarını öneriyor. Ortak İzle bu platformları her zaman "masaüstü görünümünde" (Windows'taki Chrome gibi görünerek) açar ve web oynatıcısını kullanır. Bu çoğu cihazda çalışır, ama görüntü kalitesi cihaza göre 480p–720p ile sınırlı kalabilir. Bir platform tablette hiç açılmazsa en garantili yol bilgisayarda eklentiyi kullanmaktır. Uygulama ile eklenti aynı odada birlikte çalışır: biriniz tabletten, diğeriniz bilgisayardan izleyebilir.

---

## 1. Uygulamayı kur (Android)

1. Bu depodaki [`dist/OrtakIzle.apk`](dist/OrtakIzle.apk) dosyasını tablete ve kardeşinin telefonuna/tabletine indir.
   GitHub'da dosyaya tıkla, sonra **Download raw file** (indir) düğmesine bas.
2. Dosyayı aç. Android "bilinmeyen kaynaklardan yükleme" izni isterse, açtığın uygulamaya (Chrome ya da Dosyalar) izin ver.
3. **Ortak İzle** uygulamasını aç ve adını yaz.

> Android 8.0 ve üstü gerekir.

**Güncelleme:** eski sürümü **silme**. Yeni APK aynı anahtarla imzalı; üstüne kurulur, ayarlar ve girişler kalır. 2.4.0'dan sonra uygulama yeni sürümü kendisi bulur: ana ekranda **Güncelle** kartı çıkar, dokununca indirir ve Android'in kurulum ekranını açar. İlk seferde Android "bu kaynaktan yüklemeye izin ver" ister; bir kez açman yeterli. (Ayarlar → Uygulama sürümü → **Güncellemeleri denetle** ile elle de bakabilirsin.)

## 2. Odayı tablette aç, kodu gönder

1. Tablette **Odayı aç**'a dokun. Uygulama bildirim izni isterse ver; oda açıkken bildirimde kod ve bağlı kişiler görünür.
2. Turuncu kartta **oda kodu** yazar, örneğin `K7M-4QX`. Kartın üstünde "internetten ulaşılabilir" yazınca oda hazırdır.
3. **Kodu gönder**'e dokun ve WhatsApp'tan kardeşine yolla.
4. Kardeşin uygulamada **Oda kodunu yaz** kutusuna kodu girip **Katıl**'a bassın.

Kod hep aynı kalır: bir sonraki film gecesinde tablette odayı açman yeterli, kardeşinin uygulaması kendiliğinden bağlanır. Kodu değiştirmek istersen Ayarlar → **Yeni kod al**.

Oda, uygulama arka plandayken de açık kalır. Kapatmak için karttaki ya da bildirimdeki **Odayı kapat**'a dokun.

> Aynı evdeyseniz kod yine çalışır. İsterseniz "Aynı Wi-Fi'da mısınız? Diğer yollar" altından odayı listeden seçip aracı kullanmadan da bağlanabilirsiniz.

## 3. Birlikte izleme

1. Ana ekranda platformu seç (örneğin **Disney+**). İlk seferde ortak hesabınla bir kez giriş yap; uygulama girişi hatırlar.
2. Bir bölüm aç. Kardeşine "Berkay Loki açtı · **Sen de aç**" bildirimi gider; dokununca aynı bölümde, aynı saniyede açılır.
3. Artık videonun kendi düğmeleriyle oynat, durdur, sar. Hepsi ikinizde birden olur. Oynat'a basınca video bir an durup yarım saniye içinde ikinizde **aynı anda** başlar; bu bilerek böyle.
   **Ses dili ve altyazı** da her zamanki gibi oynatıcının kendi menüsünden seçilir (Disney+'ta sağ üstteki konuşma balonu, HBO Max'te sağ alttaki menü). Herkes kendi dilini ve altyazısını ayrı seçebilir; senkronu etkilemez.
4. Sol üstteki yuvarlak **←** düğmesi bölümden çıkar. Kazara çıkılmasın diye "Bölümden çıkılsın mı?" diye sorar; telefonun geri hareketi de aynı soruyu sorar. Çıkınca video ikinizde de durur.
5. Panelde:
   - **Sadece video:** sohbeti gizler, video tam ekran olur. Gelen mesajlar videonun altından akar; sağ kenardaki düğmeyle sohbet geri açılır.
   - **Oynat/Durdur, 10 sn geri, 10 sn ileri:** sohbet açıkken videoya dokunmadan kumanda. Basınca ikinizde birden olur.
   - **Dakika:** panelde yazan süre, oynatıcının kendi ilerleme çubuğundan okunur; yani Disney+'ın gösterdiği dakikayla aynıdır.
   - **Durum:** "Senkron" yalnızca ölçülen fark çeyrek saniyenin altındayken yazar; biri geride kaldıysa "Eşitleniyor…", dakika okunamıyorsa "Güvenli mod" yazar.
   - **Senkronla:** bir şey ters giderse kumandayı en son kullananın kaldığı yere atlar.
   - **3-2-1 başlat:** ikiniz de durup aynı kareye gelirsiniz, geri sayım bitince aynı anda başlar.
   - **Buraya çağır:** açtığın bölümü diğerine gönderir.
   - Altta sohbet ve tepkiler.
6. Yatay tutunca video solda, panel sağda olur. **Sadece video** ile video tam ekrana geçer; sağ kenarın ortasında küçük bir sohbet düğmesi kalır (oynatıcının üst ve alt düğmelerini kapatmaz), mesajlar videonun sol altından akar. Dikeyde video üstte, panel altta durur.

Ayarlar (sağ üstteki dişli):
- **Bölümü sadece ben seçeyim** (yalnızca odayı açanda): açıkken diğeri bölüm değiştiremez ve bölümden çıkamaz; sen ne açarsan onda da kendiliğinden açılır. Kazara başka sayfaya giderse birkaç saniyede bölüme geri getirilir.
- **Diğeri bir şey açınca beni de götür:** bildirim beklemeden otomatik geçer.
- **Diğer sitelerde masaüstü görünümü:** bilinen platformlar zaten hep masaüstü görünümüyle açılır; bu ayar listede olmayan siteler içindir.
- **İzlerken ekranı açık tut.**
- **Oda şifresi:** odayı açan kişi şifre koyarsa katılanlar da aynısını yazar.

## 4. Bilgisayardan katılmak (Chrome / Edge eklentisi)

1. Depoyu indir: GitHub'da **Code → Download ZIP**, sonra zip'i aç.
2. Chrome'da `chrome://extensions` (Edge'de `edge://extensions`) adresini aç ve sağ üstten **Geliştirici modu**'nu aç.
3. **Paketlenmemiş öğe yükle**'ye tıkla ve `extension` klasörünü seç. Yapboz simgesinden **Ortak İzle**'yi sabitle.
4. Simgeye tıkla, tabletteki **oda kodunu** ve adını yaz, **Bağlan**'a bas.
5. Disney+ / HBO Max / Netflix sekmesinde sağ alttaki yuvarlak düğme sohbet ve kumanda panelini açar.

Firefox'ta: `about:debugging#/runtime/this-firefox` → **Geçici eklenti yükle** → `extension/manifest.json`. Firefox bu tür eklentiyi kapanınca kaldırır; kalıcı kullanım için Chrome veya Edge daha pratik.

## 5. Web paneli

Aynı Wi-Fi'da odanın adresini herhangi bir tarayıcıda açarsan (`http://192.168.1.20:8787`, adres karttaki "Aynı Wi-Fi için adres" satırında yazar) sohbet ve "kim ne izliyor" ekranı gelir. Televizyonda izlerken telefondan mesajlaşmak ve tepki göndermek için kullanışlı. Bu panel videoyu kontrol etmez.

## Sorun giderme

| Ne oluyor? | Ne yapmalı? |
|---|---|
| "Bu kodla açık bir oda bulunamadı" | Kod doğru mu? Tablette uygulama açık ve kartta "internetten ulaşılabilir" yazıyor mu? Tablet internete bağlı mı? |
| Tablette "internete bağlanıyor…" yazısı gitmiyor | Bazı okul/iş ağları bu bağlantıyı engeller; ev Wi-Fi'ında ya da mobil veride dene. |
| Bağlantı arada kopuyor | Tabletin ekranı uzun süre kapalıyken bazı telefon üreticileri uygulamaları uyutur. Ayarlar → Uygulamalar → Ortak İzle → Pil → **Kısıtlama yok** seç. |
| Disney+ / HBO Max "desteklenmeyen tarayıcı" diyor | Ayarlarda **Masaüstü görünümü** açık mı? Açıksa o cihazda web oynatıcısı desteklenmiyor demektir; bilgisayarda eklentiyle izleyin. |
| "Bu hesapta çok fazla cihaz izliyor" | Paketiniz aynı anda kaç ekrana izin veriyorsa o kadar kişi izleyebilir (Disney+ ve HBO Max'in standart paketleri 2 ekran). |
| Panelde dakika yerine "–:––" yazıyor | Uygulama o sitede videonun kaçıncı dakikada olduğunu okuyamadı. Oynat/durdur yine ikinizde birden çalışır, ama sarma (ileri/geri atlama) yalnızca "10 sn ileri/geri" olarak paylaşılır. Aynı sahneye gelmek için: ikiniz de **durdurun**, kendi oynatıcınızda aynı sahneye gelin, sonra biriniz **oynatsın**. |
| Durdurdum ama diğerinde durmadı | Birkaç saniye içinde kendiliğinden düzelir (uygulama durumu sürekli kontrol edip tekrar uygular). Düzelmezse **Senkronla**'ya dokunun. |
| Panelde "Eşitleniyor…" yazıyor | Biri takılıp geride kaldı; video birkaç saniyede kendiliğinden yetişir. "Senkron" yalnızca fark gerçekten küçükken (çeyrek saniyenin altında) yazar. |
| Netflix "tarayıcı desteklenmiyor" diyor | Netflix telefonda web oynatıcıyı engelliyor. Bilgisayarda eklentiyle izleyin. |
| Güncelleme kartı "imza farklı" diyor | Elle kurulmuş farklı bir sürüm olabilir. Bir kez uygulamayı silip [`dist/OrtakIzle.apk`](dist/OrtakIzle.apk) dosyasını kurun; sonrakiler kendiliğinden güncellenir. |
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
npm install && npm run test:e2e   # iki Chromium ile uçtan uca testler (ffmpeg gerekir):
                              # eklenti, uygulama, mesaj kaybı/inatçı oynatıcı, dakika okuma,
                              # gecikmeli ağda hassasiyet (ms), yönetici/kilit/geri düğmesi,
                              # keşif (sonradan katılma, aynı anda basma, bağlantı kopması…)
node tools/make-version.mjs "notlar"   # APK'yı dist/'e koyduktan sonra: uygulama içi güncelleme dosyası
node tools/sync-shared.mjs    # web/ değişince eklentideki kopyaları güncelle

cd android
./gradlew :core:test :app:assembleRelease   # APK: app/build/outputs/apk/release/app-release.apk
```

- Oda kodu testi (yerel MQTT aracısıyla): `npm run test:relay`; Kotlin sunucusu için `KOTLIN_SERVER=android/core/build/install/ortak-izle-sunucu/bin/ortak-izle-sunucu npm run test:relay`.
- Odayı bilgisayarda açmak için: `ODA_KODU=K7M4QX ODA_ADI=Berkay node server/server.js`.
- Kotlin sunucusu Node sunucusuyla aynı protokolü konuşur ve aynı testten geçer: `ODA_SIFRE=gizli PORT=8790 ASSETS_DIR=$PWD/web android/core/build/install/ortak-izle-sunucu/bin/ortak-izle-sunucu` ile başlat, sonra `cd server && TEST_PORT=8790 node test.js`.
- GitHub'a her gönderimde `.github/workflows/build.yml` testleri çalıştırır ve APK'yı derler (Actions → son çalışma → **OrtakIzle-apk**).
- Emülatör testi: `node tests/broker.mjs 18870 18871`, `node tests/fake-site.mjs`, test APK'sı (`./gradlew :app:assembleDebug`), sonra `node tests/e2e-android.mjs`.
- Protokol (WebSocket `/ws`, JSON): `join`, `chat`, `sync` (play/pause/seek; `at` gönderenin ölçüm anı, oynat için birkaç yüz ms sonrası = planlı ortak başlangıç), `lock` (yönetici kilidi), `drift` (izleyenin farkı), `tick` (değişiklikten sonra 10 sn boyunca saniyede bir, sonra 3 sn'de bir konum; yalnızca son kumanda edenden kabul edilir), `resend` (sıra numarası `seq` ile kaçırılan sohbet mesajlarını yeniden ister), `nav`, `invite`, `react`, `typing`, `buffer`, `countdown`, `ping`/`pong` (saat eşitleme).

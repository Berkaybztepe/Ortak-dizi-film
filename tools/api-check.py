#!/usr/bin/env python3
# Derlenmiş Kotlin kodunun, uygulamanın desteklediği en eski Android'de (API 26, Android 8.0)
# bulunmayan bir Java/Android fonksiyonu kullanıp kullanmadığını denetler.
# Derleyici bunu her zaman yakalamaz (ör. ByteArrayOutputStream.toString(Charset) Android 13'te geldi
# ve Android 12 ve altında uygulamayı çökertiyordu).
#   python3 tools/api-check.py android/core/build/classes/kotlin/main android/app/build/tmp/kotlin-classes/release
import os, subprocess, re, glob, sys, xml.etree.ElementTree as ET
MIN = 26
# Kodda Build.VERSION.SDK_INT kontrolüyle korunan, bilerek yeni sürümlere özel çağrılar
GUARDED = {
    'android/net/nsd/NsdManager.registerServiceInfoCallback(Landroid/net/nsd/NsdServiceInfo;Ljava/util/concurrent/Executor;Landroid/net/nsd/NsdManager$ServiceInfoCallback;)V',
    'android/net/nsd/NsdManager.unregisterServiceInfoCallback(Landroid/net/nsd/NsdManager$ServiceInfoCallback;)V',
    'android/net/nsd/NsdServiceInfo.getHostAddresses()Ljava/util/List;',
}
sdk = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or '/root/android-sdk'
cands = sorted(glob.glob(sdk + '/platforms/android-*/data/api-versions.xml'))
if not cands:
    sys.exit('api-versions.xml bulunamadı (ANDROID_HOME ayarlı mı?)')
tree = ET.parse(cands[-1])
api = {}
for c in tree.getroot().iter('class'):
    cname = c.get('name')
    csince = int(c.get('since', '1'))
    mem = {}
    for m in c:
        if m.tag in ('method', 'field'):
            mem[m.get('name')] = int(m.get('since', csince))
    sup = [e.get('name') for e in c if e.tag in ('extends', 'implements')]
    api[cname] = (csince, mem, sup)
def since(cls, key, seen=()):
    if cls not in api or cls in seen: return None
    csince, mem, sup = api[cls]
    if key in mem: return mem[key]
    for s in sup:
        r = since(s, key, seen + (cls,))
        if r is not None: return r
    return None
dirs = sys.argv[1:]
refs = set()
for d in dirs:
    for c in glob.glob(d + '/**/*.class', recursive=True):
        out = subprocess.run(['javap', '-c', '-p', c], capture_output=True, text=True).stdout
        for m in re.finditer(r'// (Method|InterfaceMethod|Field) ((?:java|javax|android)/[\w/$]+)\.("?[\w<>$]+"?):(\S+)', out):
            kind, cls, name, desc = m.group(1), m.group(2), m.group(3).strip('"'), m.group(4)
            key = name + desc if kind != 'Field' else name
            refs.add((cls, key))
bad = []
for cls, key in sorted(refs):
    s = since(cls, key)
    if s is None:
        if cls in api: bad.append(f'BİLİNMİYOR (muhtemelen yok): {cls}.{key}')
        continue
    if s > MIN and f'{cls}.{key}' not in GUARDED: bad.append(f'API {s} gerekiyor: {cls}.{key}')
print(f'{len(refs)} referans tarandı (en düşük Android: API {MIN})')
print('\n'.join(bad) or 'Hepsi Android 8.0 (API 26) ve üstünde mevcut ✔')
sys.exit(1 if bad else 0)

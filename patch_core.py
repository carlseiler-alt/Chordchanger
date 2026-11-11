import re, base64, sys
NEW_PAGES = 1024  # 64 MB initial (was 4096 = 256 MB)
def leb(b,i):
    r=0;s=0
    while True:
        x=b[i];i+=1;r|=(x&0x7f)<<s;s+=7
        if not x&0x80:break
    return r,i
def patch_wasm(b):
    b=bytearray(b);i=8
    while i<len(b):
        sid=b[i];i+=1;n,i=leb(b,i);end=i+n
        if sid==5:
            c,j=leb(b,i);fl=b[j];j+=1
            mn,k=leb(b,j)
            assert mn==4096 and k-j==2, (mn,k-j)
            b[j]=0x80|(NEW_PAGES&0x7f); b[j+1]=NEW_PAGES>>7
            assert leb(b,j)[0]==NEW_PAGES
            return bytes(b)
        i=end
    raise SystemExit('no memory section')
def patch_js(src,dst):
    s=open(src,encoding='latin-1').read()
    m=re.search(r'data:application/octet-stream;base64,([A-Za-z0-9+/=]{100000,})',s)
    raw=base64.b64decode(m.group(1)); new=base64.b64encode(patch_wasm(raw)).decode()
    assert len(new)==len(m.group(1))
    open(dst,'w',encoding='latin-1').write(s[:m.start(1)]+new+s[m.end(1):])
base='/home/claude/t/x/tesseract.js-core-4.0.4/package/'
for n in ['tesseract-core.wasm.js','tesseract-core-simd.wasm.js']:
    patch_js(base+n,'/home/claude/chordshift/vendor/core/'+n); print('patched',n)

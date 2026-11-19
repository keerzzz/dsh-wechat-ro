# Third-party notices

## Tencent/openclaw-weixin (MIT)

The outbound image/file wire shapes and AES-128-ECB upload sequence in
`lib/weixin-media.js` are minimally adapted from the official reference client.
No upstream plugin, account store, automatic retry loop, remote downloader or
unrestricted sender is installed or executed by this package.

Fixed revision: `874637a0dbc24050f72d1385add4fc6170a2d726`.
Repository: https://github.com/Tencent/openclaw-weixin

Reference files and SHA-256:

- `src/api/api.ts`: `7a808846a33c70423b4a4a5fcf3c1a45f885d005994218ef5f4db663d4e6e935`
- `src/api/types.ts`: `9e321e1a79bd7ec385b8e2b9695f1d87507282ff33f9cfdafbe4e33aea5387ac`
- `src/cdn/aes-ecb.ts`: `3aff4fbef828f085db0e29a146ae76aebf338308c676c9c0a68ca4d22264e93a`
- `src/cdn/cdn-upload.ts`: `3260192d3e9650e3f695d594ae6f7606e56120af55df70abc1e41cbe914500f3`
- `src/cdn/cdn-url.ts`: `d1f1e9eed76e8adb97c238a4d9967bea35d5460d2cb9bc3113a5ea1459b42646`
- `src/cdn/upload.ts`: `81ef18b5f972d29849859cfbbbc0c1be88298750eb4b2e342b2a0c43b7039cba`
- `src/messaging/send.ts`: `2f33e3e9cccb18ef03620669deb1c415749f6ac3835f4ff24f25847ecb753f4d`
- `src/messaging/send-media.ts`: `e1c1dbe303c3c2c1ae9557fc124c19dcb893fc6f626089678affc6415af7fd1c`
- `LICENSE`: `7f1e8cf099cf03de7c775e33e97e3c950c3a56a9616bb4de6b14d3c911bc5573`

The adaptation restricts both API/CDN hosts, rejects redirects, bounds content,
requires source and file revalidation, and leaves uncertain dispatches for
explicit recovery. These are local policies, not claims about all server
versions, delivery receipts, or upstream guarantees.

### Upstream license

Tencent is pleased to support the open source community by making openclaw-weixin available.

Copyright (C) 2026 Tencent. All rights reserved.

openclaw-weixin is licensed under the MIT.

Terms of the MIT:

Permission is hereby granted, free of charge, to any person obtaining
 a copy of this software and associated documentation files (the
 "Software"), to deal in the Software without restriction, including
 without limitation the rights to use, copy, modify, merge, publish,
 distribute, sublicense, and/or sell copies of the Software, and to
 permit persons to whom the Software is furnished to do so, subject to
 the following conditions:

The above copyright notice and this permission notice shall be
 included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## TANGandXUE/wcdb-key-tool (MIT)

The bundled `runtime/wcdb_key_tool.py` is a locally modified copy of
https://github.com/TANGandXUE/wcdb-key-tool. Its upstream copyright and MIT
license are retained below. Local snapshot and authorization changes do not
replace this notice.

### Upstream license

MIT License

Copyright (c) 2025 CloudDreamAI / TANGandXUE

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

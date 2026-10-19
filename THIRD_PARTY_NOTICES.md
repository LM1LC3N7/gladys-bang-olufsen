# Third-party notices

This integration ports to JavaScript a small part of the following project:
the REST endpoints and models of the Mozart API it uses (identity, product
state, sources, volume, mute, playback commands, standby), the check of the
Beolink id, and the WebSocket notification channel (port 9339, the
`WebSocketEvent*` notifications it reads) (`src/mozart/`). The generated
client is not ported, and nothing of the project is installed at runtime; its
notice is reproduced below.

## mozart-api 6.2.0.44.2 (Mozart platform API)

<https://github.com/bang-olufsen/mozart-open-api> (the OpenAPI document
`mozart-api-6.2.0.44.yaml` and the Python client `mozart-api`, published by
Bang & Olufsen; the library behind the Home Assistant Bang & Olufsen
integration)

```
MIT License

Copyright (c) 2022 Bang & Olufsen a/s

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
```

## Home Assistant, Bang & Olufsen integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/bang_olufsen>
(Apache License 2.0): only consulted, no code copied. The mDNS service type
it browses (`_bangolufsen._tcp`) is reused as a fact.

## LM1LC3N7/gladys-devialet

The structure of the app (polling and backoff, command queue and budget,
`/data` store, handler wiring) follows this integration of the same author,
under the Apache License 2.0 of this repository.

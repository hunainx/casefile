# Third-party notices

Casefile's own code is under the GNU Affero General Public License v3.0 ([LICENSE](LICENSE)). This file lists the
third-party code the repository ships, modifies or needs, and its licences.

## Code shipped in this repository

### A patch to pst-extractor (MIT)

`patches/pst-extractor@1.12.0.patch` modifies [pst-extractor](https://github.com/epfromer/pst-extractor) 1.12.0
(applied by pnpm's `patchedDependencies`, see decision D110 in docs/DECISIONS.md): embedded messages are returned,
and a message the library cannot load is recorded instead of skipped. The patch changes files of pst-extractor
and is provided under pst-extractor's own licence, the MIT licence:

> MIT License
>
> Copyright (c) Ed Pfromer and the pst-extractor contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
> to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions
> of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
> THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
> IN THE SOFTWARE.

(The npm package declares `"license": "MIT"` and its author as Ed Pfromer; it ships no separate licence file.)

### Test fixtures

Every file in `test-corpus/` and every generated fake document was made by this project's own generators or by
hand, with invented names and reserved example domains ([test-corpus/SOURCES.md](test-corpus/SOURCES.md)). No
third-party fixture is included.

### SheetJS Community Edition 0.20.3 (Apache-2.0)

`vendor/xlsx-0.20.3.tgz` is the `xlsx` package exactly as SheetJS publishes it at
https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz (2,409,319 bytes, SHA-256
`8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`), unmodified. SheetJS no longer publishes to
npm, where the last version, 0.18.5, has two open security advisories; the lockfile pins the tarball's sha512
(decision D135). It is (C) 2013-present SheetJS (its own header), under the Apache License 2.0; the licence text is
inside the tarball (`package/LICENSE`).

## Not in this repository

- **PSTFileFormat** (by ROM Knowledgeware, LGPL-3.0-or-later) and **Microsoft's `Empty.pst`** (from
  microsoft/outlook-pst-rs, MIT) are needed only to write fake PST files for tests. `tools/fake-corpus` fetches
  them at pinned commits into a folder outside the repository, on Windows, when a fake PST is made (decision
  D114). Neither is committed, vendored or part of Casefile's runtime.
  `tools/fake-corpus/pst-writer/PstWriter.cs` is Casefile's own code (AGPL-3.0) that calls that library.
- **The local development containers** in `infra/compose.yml` (Postgres with pgvector, fake-gcs-server, Redis)
  are pulled from their publishers when you run Docker, under their own licences. They are not part of
  Casefile.

## Dependencies installed from npm

Casefile's dependencies are not copied into the repository (except the SheetJS tarball above); `pnpm install`
downloads them, each under its own licence. The production dependencies (281 packages in `pnpm licenses list
--prod`, 2026-10-01) are under permissive licences: MIT (230), Apache-2.0 (14), BSD-2-Clause (11), ISC (11),
BSD-3-Clause (8), and one each of 0BSD, MIT-0 (nodemailer), Unlicense (postgres), BSD (duck), MIT AND Zlib
(pako), MIT OR EUPL-1.1+ (@zone-eu/mailsplit), MIT OR GPL-3.0-or-later (jszip, used under MIT). None is
copyleft-only.

The direct production dependencies:

| Package | Version | Licence |
|---|---|---|
| @fastify/cors | 10.1.0 | MIT |
| @google-cloud/storage | 8.0.1 | Apache-2.0 |
| @kenjiuno/msgreader | 1.28.0 | Apache-2.0 |
| @modelcontextprotocol/sdk | 1.30.0 | MIT |
| @simplewebauthn/server | 13.3.3 | MIT |
| adm-zip | 0.6.1 | MIT |
| argon2 | 0.41.1 | MIT |
| fastify | 5.12.1 | MIT |
| google-auth-library | 9.15.1 | Apache-2.0 |
| html-to-text | 10.0.1 | MIT |
| long | 5.3.2 | Apache-2.0 |
| mailparser | 3.9.32 | MIT |
| mammoth | 1.12.2 | BSD-2-Clause |
| pdf-lib | 1.17.1 | MIT |
| postgres | 3.4.9 | Unlicense |
| pst-extractor | 1.12.0 (patched, above) | MIT |
| unpdf | 1.8.1 | MIT |
| word-extractor | 1.0.4 | MIT |
| xlsx | 0.20.3 (vendored, above) | Apache-2.0 |
| zod | 3.25.76 | MIT |

To see the full, current list: `pnpm licenses list --prod`. A Docker image built from the `Dockerfile` contains
these packages; distributing such an image means distributing them, under their licences.

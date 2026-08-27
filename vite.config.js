import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// base: './' — 상대 경로로 빌드해서 어느 호스팅에 올려도 그대로 동작한다.
// GitHub Pages 하위 경로(/namparang/), Cloudflare Pages, Netlify 모두 수정 없이 배포.
/**
 * 데이터 캐시 버스터.
 *
 * `public/data/*.json` 은 파일명에 해시가 없어 GitHub Pages 캐시(10분)에 걸린다.
 * 새 JS 가 옛 데이터를 받으면(예: `eleLow` 없는 `courses.json`) 화면이 깨진다.
 *
 * 값은 **데이터 생성 시각**(`meta.json` 의 `generatedAt`)에서 뽑는다.
 * `Date.now()` 를 쓰면 소스가 같아도 빌드마다 산출물이 달라져
 *   - 빌드가 재현되지 않고
 *   - 내용이 그대로인데도 매 배포마다 사용자가 JS 를 다시 받는다.
 * 데이터가 바뀔 때만 바뀌어야 맞다.
 */
function dataVersion() {
  try {
    const meta = JSON.parse(readFileSync('public/data/meta.json', 'utf8'))
    if (meta.generatedAt) return meta.generatedAt.replace(/[^0-9]/g, '').slice(0, 14)
  } catch {
    // 아직 npm run build:data 를 돌리지 않은 상태
  }
  return 'nodata'
}

const BUILD_ID = dataVersion()

export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: {
    target: 'es2020',
    // 데이터 JSON은 public/ 에서 그대로 복사되므로 해시가 붙지 않는다.
    // 앱이 상대 경로로 fetch 하려면 이게 필요하다.
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
  },
})

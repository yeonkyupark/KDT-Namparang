import { defineConfig } from 'vite'

// base: './' — 상대 경로로 빌드해서 어느 호스팅에 올려도 그대로 동작한다.
// GitHub Pages 하위 경로(/namparang/), Cloudflare Pages, Netlify 모두 수정 없이 배포.
// 빌드마다 바뀌는 값. public/data/*.json 은 파일명에 해시가 없어서
// GitHub Pages 캐시(10분)에 걸린다. 새 JS 가 옛 데이터를 받으면
// (예: eleLow 가 없는 courses.json) 화면이 깨지므로 쿼리로 캐시를 깬다.
const BUILD_ID = Date.now().toString(36)

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

/**
 * GitHub Contents API — SDK 없이 fetch 로만 쓴다.
 *
 * 필요한 동작이 넷뿐이다: 파일 읽기, JSON 쓰기, 바이너리 쓰기, 토큰 확인.
 * Octokit(수십 KB)을 넣을 이유가 없다.
 *
 * 읽기는 `raw.githubusercontent.com` 으로 간다 — CORS 가 열려 있고, 5분 캐시라
 * 갓 올린 파일도 곧 보이며, **api.github.com 의 미인증 60req/hr 한도에 걸리지 않는다.**
 * 쓰기는 인증되므로 5,000req/hr — 개인 사용에는 사실상 무제한이다.
 */

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

/** Uint8Array → base64. 큰 배열을 한 번에 스프레드하면 스택이 터지므로 나눠 돈다. */
function toBase64(bytes) {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/** 한글이 들어간 JSON 은 btoa 로 바로 못 넘긴다(Latin1 전용). UTF-8 로 인코딩해서 넘긴다. */
function jsonToBase64(value) {
  return toBase64(new TextEncoder().encode(JSON.stringify(value, null, 1)))
}

async function blobToBase64(blob) {
  return toBase64(new Uint8Array(await blob.arrayBuffer()))
}

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * @param {{owner: string, repo: string, branch?: string, token?: string}} cfg
 */
export function createClient(cfg) {
  const branch = cfg.branch || 'main'

  const authHeaders = () =>
    cfg.token ? { ...HEADERS, Authorization: `Bearer ${cfg.token}` } : { ...HEADERS }

  async function api(path, init = {}) {
    const res = await fetch(`${API}${path}`, { ...init, headers: { ...authHeaders(), ...init.headers } })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!res.ok) {
      throw new GitHubError(body?.message || `HTTP ${res.status}`, res.status, body)
    }
    return body
  }

  const contentsPath = (path) =>
    `/repos/${cfg.owner}/${cfg.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`

  return {
    get config() {
      return { owner: cfg.owner, repo: cfg.repo, branch }
    },

    rawUrl(path) {
      return `${RAW}/${cfg.owner}/${cfg.repo}/${branch}/${path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`
    },

    /** raw 로 JSON 을 읽는다. 없으면 null. */
    async readJson(path) {
      const res = await fetch(`${this.rawUrl(path)}?t=${Date.now()}`, { cache: 'no-store' })
      if (res.status === 404) return null
      if (!res.ok) throw new GitHubError(`읽기 실패 HTTP ${res.status}`, res.status, null)
      return res.json()
    },

    /**
     * 쓰기 직전에 쓸 sha + 내용을 **한 번에** 읽는다.
     *
     * sha 는 API(즉시 최신)에서, 내용은 raw(최대 5분 캐시)에서 따로 읽으면
     * 방금 다른 기기가 올린 변경을 못 본 채 최신 sha 로 덮어써서 되돌릴 수 있다.
     * Contents API 는 둘을 원자적으로 준다.
     *
     * @returns {Promise<{sha: string, json: any}|null>} 파일이 없으면 null
     */
    async getFileJson(path) {
      let r
      try {
        r = await api(`${contentsPath(path)}?ref=${encodeURIComponent(branch)}`, {
          cache: 'no-store',
        })
      } catch (e) {
        if (e.status === 404) return null
        throw e
      }

      // 1MB 를 넘으면 Contents API 가 content 를 비워 보낸다. 그때만 raw 로 받는다.
      if (!r.content && r.download_url) {
        const res = await fetch(`${r.download_url}?t=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) throw new GitHubError(`읽기 실패 HTTP ${res.status}`, res.status, null)
        return { sha: r.sha, json: await res.json() }
      }

      const bytes = Uint8Array.from(atob(r.content.replace(/\s/g, '')), (c) => c.charCodeAt(0))
      return { sha: r.sha, json: JSON.parse(new TextDecoder().decode(bytes)) }
    },

    /** 쓰기에 필요한 현재 sha. 파일이 없으면 null. */
    async headSha(path) {
      try {
        const r = await api(`${contentsPath(path)}?ref=${encodeURIComponent(branch)}`)
        return r?.sha ?? null
      } catch (e) {
        if (e.status === 404) return null
        throw e
      }
    },

    /**
     * 파일을 쓴다. `sha` 를 주면 그 버전에서만 덮어쓴다(낙관적 락).
     * 그 사이 다른 곳에서 바뀌었으면 409 가 오고, 호출부가 다시 읽어 병합한다.
     */
    async putFile(path, base64, { message, sha }) {
      return api(contentsPath(path), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content: base64, branch, ...(sha ? { sha } : {}) }),
      })
    },

    putJson(path, value, opts) {
      return this.putFile(path, jsonToBase64(value), opts)
    },

    async putBlob(path, blob, opts) {
      return this.putFile(path, await blobToBase64(blob), opts)
    },

    /**
     * 브랜치의 전체 파일 경로 목록. 요청 1회로 리포에 뭐가 있는지 다 안다.
     *
     * 사진 존재 확인을 파일마다 `headSha` 로 하면 N회 요청이 되고, raw 는
     * 5분 캐시라 방금 지워진 파일을 아직 있다고 답한다. 트리는 즉시 정확하다.
     *
     * @returns {Promise<Set<string>|null>} 경로 집합. 리포가 비었거나
     *          항목이 10만개를 넘어 잘렸으면 null (= 판단 보류).
     */
    async listPaths() {
      try {
        const r = await api(
          `/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        )
        if (r?.truncated) return null
        return new Set((r?.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path))
      } catch (e) {
        // 파일이 하나도 없는 브랜치는 빈 트리(4b825dc6…)를 가리키는데, GitHub 은
        // 그 트리를 객체로 저장하지 않아 404 를 준다. 커밋 이력이 있어도 마찬가지다.
        // 빈 리포(409)도 같은 뜻이다. 둘 다 "파일 없음"이 확실하므로 빈 집합.
        if (e.status === 404 || e.status === 409) return new Set()
        throw e
      }
    },

    /** 파일이 이미 있으면 건너뛴다. 사진은 한 번 올리면 바뀌지 않는다. */
    async putBlobIfAbsent(path, blob, message) {
      const sha = await this.headSha(path)
      if (sha) return { skipped: true, path }
      await this.putBlob(path, blob, { message })
      return { skipped: false, path }
    },

    /** 토큰이 가리키는 사용자. */
    async whoami() {
      if (!cfg.token) throw new GitHubError('토큰이 없습니다', 401, null)
      const user = await api('/user')
      return user.login
    },

    /**
     * 이 클라이언트가 가리키는 리포의 상태.
     *
     * `defaultBranch` 와 `empty` 를 함께 본다. 갓 만든 리포는 커밋이 없어
     * 기본 브랜치도 없는데, 그 상태에서 `branch` 를 지정해 쓰면 실패한다.
     */
    async repoInfo() {
      const repo = await api(`/repos/${cfg.owner}/${cfg.repo}`)
      let empty = false
      try {
        await api(`/repos/${cfg.owner}/${cfg.repo}/commits?per_page=1`)
      } catch (e) {
        if (e.status === 409) empty = true // "Git Repository is empty"
        else if (e.status !== 404) throw e
      }
      return {
        fullName: repo.full_name,
        canWrite: Boolean(repo.permissions?.push),
        isPrivate: Boolean(repo.private),
        defaultBranch: repo.default_branch ?? null,
        empty,
      }
    },
  }
}

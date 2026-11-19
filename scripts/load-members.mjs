#!/usr/bin/env node
/** 从 MH_MEMBERS（内联 JSON）或 MH_MEMBERS_FILE 加载成员目录；解析交给 build 产物。 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseDirectory } from '../build/src/runtime/identity.js'

export function loadMembersFromEnv(options = {}) {
  const inline = process.env.MH_MEMBERS?.trim()
  const file = process.env.MH_MEMBERS_FILE?.trim() || 'config/members.json'
  let raw = null
  let source = null

  if (inline) {
    raw = inline
    source = 'MH_MEMBERS (inline)'
  } else if (existsSync(resolve(file))) {
    raw = readFileSync(resolve(file), 'utf8')
    source = file
  } else if (options.required) {
    throw new Error(
      `缺少成员目录：把 config/members.example.json 复制为 ${file}，或设置 MH_MEMBERS 内联 JSON。`,
    )
  } else {
    return null
  }

  let parsed
  try { parsed = JSON.parse(raw) } catch (err) {
    throw new Error(`成员目录不是合法 JSON（${source}）：${err.message}`)
  }
  const directory = parseDirectory(parsed)
  return { directory, source, memberCount: directory.members.size }
}

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian')
const crypto = require('crypto')

const DEFAULT_SETTINGS = {
  accessKeyId: '',
  accessKeySecret: '',
  bucket: '9046xiaomai-doc',
  region: 'oss-cn-beijing',
  ossPrefix: 'docs/',
  useRelativePath: false,
  compress: true,
  maxWidth: 1920,
  maxKB: 400,
  quality: 80,
  deleteRemote: true,
}

function pad(num, len = 2) {
  return String(num).padStart(len, '0')
}

function stampName() {
  const d = new Date()
  const n = Math.floor(Math.random() * 1000)
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
    pad(n, 3),
  ].join('')
}

function sanitizeSegment(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
}

function folderFromNote(relPath, useRelativePath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel) {
    return '未分类'
  }
  const noExt = rel.replace(/\.md$/i, '')
  const parts = (useRelativePath ? noExt.split('/') : [noExt.split('/').pop()])
    .map(sanitizeSegment)
    .filter(Boolean)
  return parts.join('/') || '未分类'
}

function joinOssKey(prefix, folder, fileName) {
  return [prefix, folder, fileName]
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
}

function encodeOssUrlPath(key) {
  return key.split('/').map(encodeURIComponent).join('/')
}

function collectImageFiles(data) {
  const files = []
  if (!data) {
    return files
  }
  if (data.files && data.files.length) {
    for (const file of data.files) {
      if (file && String(file.type || '').startsWith('image/')) {
        files.push(file)
      }
    }
  }
  if (!files.length && data.items && data.items.length) {
    for (const item of data.items) {
      if (item && String(item.type || '').startsWith('image/')) {
        const file = item.getAsFile && item.getAsFile()
        if (file) {
          files.push(file)
        }
      }
    }
  }
  return files
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality)
  })
}

async function compressImageFile(file, settings) {
  const type = String(file.type || 'image/png')
  if (type === 'image/gif' || type === 'image/svg+xml') {
    return {
      buffer: await file.arrayBuffer(),
      contentType: type,
      ext: type === 'image/gif' ? '.gif' : '.svg',
    }
  }

  const maxWidth = Number(settings.maxWidth) || 1920
  const maxBytes = (Number(settings.maxKB) || 400) * 1024
  const raw = await file.arrayBuffer()
  if (!settings.compress) {
    const ext = type.includes('jpeg') || type.includes('jpg') ? '.jpg' : '.png'
    return { buffer: raw, contentType: type, ext }
  }

  let bitmap
  try {
    bitmap = await createImageBitmap(new Blob([raw], { type }))
  }
  catch {
    return { buffer: raw, contentType: type, ext: '.png' }
  }

  const scale = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close && bitmap.close()

  if (raw.byteLength <= maxBytes && scale === 1 && (type.includes('jpeg') || type.includes('jpg'))) {
    return { buffer: raw, contentType: type, ext: '.jpg' }
  }

  let quality = Math.min(0.9, Math.max(0.4, (Number(settings.quality) || 80) / 100))
  let blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  while (blob && blob.size > maxBytes && quality > 0.4) {
    quality -= 0.1
    blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  }
  if (!blob) {
    return { buffer: raw, contentType: type, ext: '.png' }
  }
  return {
    buffer: await blob.arrayBuffer(),
    contentType: 'image/jpeg',
    ext: '.jpg',
  }
}

function ossAuthorization(method, contentType, date, resource, id, secret) {
  const stringToSign = `${method}\n\n${contentType}\n${date}\n${resource}`
  const signature = crypto.createHmac('sha1', secret).update(stringToSign).digest('base64')
  return `OSS ${id}:${signature}`
}

function ossCreds(settings) {
  const id = String(settings.accessKeyId || '').trim()
  const secret = String(settings.accessKeySecret || '').trim()
  const bucket = String(settings.bucket || '').trim()
  const region = String(settings.region || 'oss-cn-beijing').trim()
  if (!id || !secret || !bucket) {
    throw new Error('请先在插件设置里填 AccessKey、Secret 和 Bucket')
  }
  return { id, secret, bucket, region, host: `${bucket}.${region}.aliyuncs.com` }
}

function extractOssUrls(text) {
  const urls = []
  const md = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi
  const html = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi
  let match
  while ((match = md.exec(String(text || '')))) {
    urls.push(match[1])
  }
  while ((match = html.exec(String(text || '')))) {
    urls.push(match[1])
  }
  return urls
}

function countUrls(urls) {
  const map = new Map()
  for (const url of urls) {
    map.set(url, (map.get(url) || 0) + 1)
  }
  return map
}

function keyFromOssUrl(url, settings) {
  let parsed
  try {
    parsed = new URL(url)
  }
  catch {
    return ''
  }
  const host = `${String(settings.bucket || '').trim()}.${String(settings.region || 'oss-cn-beijing').trim()}.aliyuncs.com`
  if (parsed.host !== host) {
    return ''
  }
  const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  const prefix = String(settings.ossPrefix || 'docs/').replace(/^\/+|\/+$/g, '')
  if (prefix && key !== prefix && !key.startsWith(`${prefix}/`)) {
    return ''
  }
  return key
}

async function putOssObject(settings, key, buffer, contentType) {
  const { id, secret, bucket, host } = ossCreds(settings)
  const date = new Date().toUTCString()
  const resource = `/${bucket}/${key}`
  const authorization = ossAuthorization('PUT', contentType, date, resource, id, secret)
  const res = await requestUrl({
    url: `https://${host}/${encodeOssUrlPath(key)}`,
    method: 'PUT',
    headers: {
      Date: date,
      'Content-Type': contentType,
      Authorization: authorization,
    },
    body: buffer,
    throw: false,
  })
  if (res.status >= 300) {
    const text = typeof res.text === 'string' ? res.text : ''
    throw new Error(`OSS 上传失败 ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
  }
  return `https://${host}/${encodeOssUrlPath(key)}`
}

async function deleteOssObject(settings, key) {
  const { id, secret, bucket, host } = ossCreds(settings)
  const date = new Date().toUTCString()
  const resource = `/${bucket}/${key}`
  const authorization = ossAuthorization('DELETE', '', date, resource, id, secret)
  const res = await requestUrl({
    url: `https://${host}/${encodeOssUrlPath(key)}`,
    method: 'DELETE',
    headers: {
      Date: date,
      Authorization: authorization,
    },
    throw: false,
  })
  if (res.status >= 300 && res.status !== 404) {
    const text = typeof res.text === 'string' ? res.text : ''
    throw new Error(`OSS 删除失败 ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
  }
}

class DocFolderOssSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display() {
    const { containerEl } = this
    containerEl.empty()
    containerEl.createEl('h2', { text: '按文档分夹' })
    containerEl.createEl('p', { text: '粘贴或拖入图片时，按当前笔记建目录，压完传到阿里云 OSS。密钥只存在本机插件设置里。' })

    const s = this.plugin.settings
    const save = async () => {
      await this.plugin.saveSettings()
    }

    new Setting(containerEl)
      .setName('AccessKey ID')
      .addText((text) => {
        text.setValue(s.accessKeyId).onChange(async (value) => {
          this.plugin.settings.accessKeyId = value.trim()
          await save()
        })
      })

    new Setting(containerEl)
      .setName('AccessKey Secret')
      .addText((text) => {
        text.inputEl.type = 'password'
        text.setValue(s.accessKeySecret).onChange(async (value) => {
          this.plugin.settings.accessKeySecret = value.trim()
          await save()
        })
      })

    new Setting(containerEl)
      .setName('Bucket')
      .addText((text) => {
        text.setValue(s.bucket).onChange(async (value) => {
          this.plugin.settings.bucket = value.trim()
          await save()
        })
      })

    new Setting(containerEl)
      .setName('地域')
      .setDesc('例如 oss-cn-beijing')
      .addText((text) => {
        text.setValue(s.region).onChange(async (value) => {
          this.plugin.settings.region = value.trim()
          await save()
        })
      })

    new Setting(containerEl)
      .setName('OSS 前缀')
      .setDesc('默认 docs/')
      .addText((text) => {
        text.setValue(s.ossPrefix).onChange(async (value) => {
          this.plugin.settings.ossPrefix = value.trim()
          await save()
        })
      })

    new Setting(containerEl)
      .setName('用仓库相对路径当分夹')
      .setDesc('关掉则只用笔记文件名，例如 docs/3.chrome-ruhe-daochu-cookie/')
      .addToggle((toggle) => {
        toggle.setValue(s.useRelativePath).onChange(async (value) => {
          this.plugin.settings.useRelativePath = value
          await save()
        })
      })

    new Setting(containerEl)
      .setName('上传前压缩')
      .addToggle((toggle) => {
        toggle.setValue(s.compress).onChange(async (value) => {
          this.plugin.settings.compress = value
          await save()
        })
      })

    new Setting(containerEl)
      .setName('最长边像素')
      .addText((text) => {
        text.setValue(String(s.maxWidth)).onChange(async (value) => {
          this.plugin.settings.maxWidth = Number(value) || 1920
          await save()
        })
      })

    new Setting(containerEl)
      .setName('单张上限 KB')
      .addText((text) => {
        text.setValue(String(s.maxKB)).onChange(async (value) => {
          this.plugin.settings.maxKB = Number(value) || 400
          await save()
        })
      })

    new Setting(containerEl)
      .setName('JPEG 起始质量')
      .setDesc('1～100，还超上限会再往下降')
      .addText((text) => {
        text.setValue(String(s.quality)).onChange(async (value) => {
          this.plugin.settings.quality = Number(value) || 80
          await save()
        })
      })

    new Setting(containerEl)
      .setName('删除笔记图片时同时删云端')
      .setDesc('从这篇里拿掉本桶 docs/ 下的图链接后，约 1.5 秒后删 OSS。剪下马上粘贴一般不会误删。撤销晚了图会 404。')
      .addToggle((toggle) => {
        toggle.setValue(s.deleteRemote).onChange(async (value) => {
          this.plugin.settings.deleteRemote = value
          await save()
        })
      })
  }
}

module.exports = class DocFolderOssPlugin extends Plugin {
  async onload() {
    await this.loadSettings()
    this.fileUrlMap = new Map()
    this.deleteTimers = new Map()
    this.addSettingTab(new DocFolderOssSettingTab(this.app, this))

    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      void this.snapshotFile(file)
    }))
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      const file = (info && info.file) || this.app.workspace.getActiveFile()
      if (!file || file.extension !== 'md') {
        return
      }
      this.scheduleRemoteDelete(file.path, editor.getValue())
    }))

    const active = this.app.workspace.getActiveFile()
    if (active) {
      void this.snapshotFile(active)
    }

    this.registerEvent(this.app.workspace.on('editor-paste', (evt, editor) => {
      void this.handleDataTransfer(evt, editor, evt.clipboardData)
    }))
    this.registerEvent(this.app.workspace.on('editor-drop', (evt, editor) => {
      void this.handleDataTransfer(evt, editor, evt.dataTransfer)
    }))

    this.addCommand({
      id: 'upload-clipboard-image',
      name: '上传剪贴板图片',
      editorCallback: async (editor) => {
        try {
          const items = await navigator.clipboard.read()
          const files = []
          for (const item of items) {
            const type = item.types.find(name => name.startsWith('image/'))
            if (!type) {
              continue
            }
            const blob = await item.getType(type)
            files.push(new File([blob], `paste${stampName()}.png`, { type: blob.type || 'image/png' }))
          }
          if (!files.length) {
            new Notice('剪贴板里没有图片')
            return
          }
          await this.uploadFiles(files, editor)
        }
        catch (error) {
          new Notice(error.message || '读剪贴板失败')
        }
      },
    })
  }

  onunload() {
    for (const timer of this.deleteTimers.values()) {
      clearTimeout(timer)
    }
    this.deleteTimers.clear()
  }

  async snapshotFile(file) {
    if (!file || file.extension !== 'md') {
      return
    }
    const text = await this.app.vault.cachedRead(file)
    this.fileUrlMap.set(file.path, countUrls(extractOssUrls(text)))
  }

  scheduleRemoteDelete(path, text) {
    const current = countUrls(extractOssUrls(text))
    if (!this.fileUrlMap.has(path)) {
      this.fileUrlMap.set(path, current)
      return
    }
    const old = this.deleteTimers.get(path)
    if (old) {
      clearTimeout(old)
    }
    const timer = setTimeout(() => {
      this.deleteTimers.delete(path)
      void this.flushRemoteDelete(path, current)
    }, 1500)
    this.deleteTimers.set(path, timer)
  }

  async flushRemoteDelete(path, current) {
    const prev = this.fileUrlMap.get(path) || new Map()
    this.fileUrlMap.set(path, current)
    if (!this.settings.deleteRemote) {
      return
    }
    for (const [url, prevCount] of prev.entries()) {
      const now = current.get(url) || 0
      if (now > 0 || prevCount <= 0) {
        continue
      }
      const key = keyFromOssUrl(url, this.settings)
      if (!key) {
        continue
      }
      try {
        await deleteOssObject(this.settings, key)
        new Notice(`已删除云端 ${key}`)
      }
      catch (error) {
        new Notice(error.message || '云端删除失败')
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  async handleDataTransfer(evt, editor, data) {
    const files = collectImageFiles(data)
    if (!files.length) {
      return
    }
    evt.preventDefault()
    try {
      await this.uploadFiles(files, editor)
    }
    catch (error) {
      new Notice(error.message || '上传失败')
    }
  }

  noteFolder() {
    const file = this.app.workspace.getActiveFile()
    return folderFromNote(file ? file.path : '', this.settings.useRelativePath)
  }

  async uploadFiles(files, editor) {
    const folder = this.noteFolder()
    const urls = []
    for (const file of files) {
      new Notice(`正在上传到 ${folder} …`)
      const packed = await compressImageFile(file, this.settings)
      const key = joinOssKey(this.settings.ossPrefix || 'docs/', folder, `${stampName()}${packed.ext}`)
      const url = await putOssObject(this.settings, key, packed.buffer, packed.contentType)
      urls.push(url)
    }
    const markdown = urls.map(url => `![](${url})`).join('\n')
    if (editor && markdown) {
      editor.replaceSelection(markdown)
    }
    new Notice('图片已上传')
  }
}

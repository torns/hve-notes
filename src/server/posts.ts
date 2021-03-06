import * as fs from 'fs'
import Model from './model'
import * as fse from 'fs-extra'
import * as path from 'path'
// tslint:disable-next-line
const junk = require('junk')
import { IPost, IPostDb } from './interfaces/post'
import ContentHelper from '../helpers/content-helper'
import matter from 'gray-matter'
import moment from 'moment'
import Bluebird from 'bluebird'
Bluebird.promisifyAll(fs)

export default class Posts extends Model {
  postDir: string
  postImageDir: string

  constructor(appInstance: any) {
    super(appInstance)
    this.postDir = path.join(this.appDir, 'posts')
    this.postImageDir = `${this.appDir}/post-images`
  }

  public async savePosts() {
    const resultList: any = []
    const requestList: any = []
    let files = await fse.readdir(this.postDir)

    files = files.filter(junk.not)
    files.forEach((item) => {
      requestList.push(fs.readFileSync(path.join(this.postDir, item), 'utf8'))
    })
    const results = await Bluebird.all(requestList)
    const fixedResults = JSON.parse(JSON.stringify(results))
    /**
     * 修正标签格式由字符串换为数组，并更新文章源文件 from v0.7.6
     */
    await Promise.all(results.map(async (result: any, index: any) => {
      const postMatter = matter(result)
      const data = (postMatter.data as any)

      if (data && data.date) {
        if (typeof data.date === 'string') {
          data.date = moment(data.date).format('YYYY-MM-DD HH:mm:ss')
        } else {
          data.date = moment(data.date).subtract(8, 'hours').format('YYYY-MM-DD HH:mm:ss')
        }
      }

      // 如果有标签，并且为字符串类型，则修正为数组类型
      if (data && typeof data.tags === 'string') {
        const tagReg = /tags: [^\s\[]/i
        const newTagString = data.tags.split(' ').toString()

        if (tagReg.test(result)) {
          const mdStr = `---
title: ${data.title}
date: ${data.date}
tags: [${newTagString}]
published: ${data.published || false}
hideInList: ${data.hideInList || false}
feature: ${data.feature || ''}
---
${postMatter.content}`

          fixedResults[index] = mdStr
          await fse.writeFileSync(`${this.postDir}/${files[index]}`, mdStr)
        }
      }
    }))

    fixedResults.forEach((result: any, index: any) => {
      const postMatter = matter(result)

      // 修正 matter 格式化掉 日期问题
      const data = (postMatter.data as any)

      if (data && data.date) {
        if (typeof data.date === 'string') {
          data.date = moment(data.date).format('YYYY-MM-DD HH:mm:ss')
        } else {
          data.date = moment(data.date).subtract(8, 'hours').format('YYYY-MM-DD HH:mm:ss')
        }
      }

      delete postMatter.orig // Remove orig <Buffer>
      const post = {
        ...postMatter,
        abstract: '',
        fileName: '',
      }

      const moreReg = /\n\s*<!--\s*more\s*-->\s*\n/i
      const matchMore = moreReg.exec(post.content)
      if (matchMore) {
        post.abstract = (post.content).substring(0, matchMore.index) // 摘要
      }

      post.fileName = files[index].substring(0, files[index].length - 3) // 有待优化!
      resultList.push(post)
    })

    const list: any = []
    resultList.forEach((item: any) => {
      // 从 hexo 或其他平台迁移过来的文章不带有 published 字段
      if (item.data.published === undefined) {
        item.data.published = false
      }

      // 从其他平台迁移过来的文章或旧文章不带有 hideInList 字段
      if (item.data.hideInList === undefined) {
        item.data.hideInList = false
      }

      list.push(item)
    })

    list.sort((a: any, b: any) => moment(b.data.date).unix() - moment(a.data.date).unix())

    this.$posts.set('posts', list).write()
    return true
  }

  async list() {
    await this.savePosts()
    // await this.$posts.defaults({ posts: [] }).write()
    const posts = await this.$posts.get('posts').value()
    const helper = new ContentHelper()

    const list = posts.map((post: IPostDb) => {
      const item = JSON.parse(JSON.stringify(post))
      item.content = helper.changeImageUrlDomainToLocal(item.content, this.appDir)
      item.data.feature = item.data.feature ? helper.changeFeatureImageUrlDomainToLocal(item.data.feature, this.appDir) : item.data.feature
      return item
    })

    return list
  }

  /**
   * 保存文章到文件
   * @param post 文章
   */
  async savePostToFile(post: IPost): Promise<IPost | null> {
    const helper = new ContentHelper()
    const content = helper.changeImageUrlLocalToDomain(post.content, this.db.setting.domain)
    const extendName = (post.featureImage.name || 'jpg').split('.').pop()

    const mdStr = `---
title: ${post.title}
date: ${post.date}
tags: [${post.tags.join(',')}]
published: ${post.published}
hideInList: ${post.hideInList}
feature: ${post.featureImage.name ? `/post-images/${post.fileName}.${extendName}` : ''}
---
${content}`

    try {

      // 存在文章大图
      if (post.featureImage.path) {

        const filePath = `${this.postImageDir}/${post.fileName}.${extendName}`

        if (post.featureImage.path !== filePath) {
          await fse.copySync(post.featureImage.path, filePath)

          // 清除旧文件
          if (post.featureImage.path.includes(this.postImageDir)) {
            await fse.removeSync(post.featureImage.path)
          }
        }
      }

      // write file must use fse, beause fs.writeFile need callback
      await fse.writeFile(`${this.postDir}/${post.fileName}.md`, mdStr)

      // 清除旧文件
      if (post.deleteFileName) {
        await fse.removeSync(`${this.postDir}/${post.deleteFileName}.md`)
      }
    } catch (e) {
      console.error('ERROR: ', e)
    }
    return post
  }

  async deletePost(post: IPostDb) {
    try {
      const postUrl = `${this.postDir}/${post.fileName}.md`
      await fse.removeSync(postUrl)

      // clean feature image
      if (post.data.feature) {
        await fse.removeSync(post.data.feature.replace('file://', ''))
      }

      // clean post content image
      const imageReg = /(!\[.*?\]\()(.+?)(\))/g
      const imageList = post.content.match(imageReg)
      if (imageList) {
        const postImagePaths = imageList.map((item: string) => {
          const index = item.indexOf('(')
          return item.substring(index + 1, item.length - 1)
        })
        postImagePaths.forEach(async (filePath: string) => {
          await fse.removeSync(filePath.replace('file://', ''))
        })
      }
      return true
    } catch (e) {
      console.error('Delete Error', e)
      return false
    }
  }

  async uploadImages(files: any[]) {
    console.log('传过来的 files', files)
    await fse.ensureDir(this.postImageDir)
    const results = []
    for (const file of files) {
      const extendName = file.name.split('.').pop()
      const newFileName = new Date().getTime()
      const filePath = `${this.postImageDir}/${newFileName}.${extendName}`
      await fse.copySync(file.path, filePath)
      results.push(filePath)
      console.log('复制成功')
    }
    return results
  }
}

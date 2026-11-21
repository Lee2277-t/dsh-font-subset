# dsh-font-subset

按实际用到的字裁剪字体，并报告字体里缺哪些字。

## 为什么

中文网页字体动辄 5–15 MB。一个落地页加载一个中就超预算了，而页面真正用到的字通常只有几百个。

实测：

```
font_subset C:\Windows\Fonts\simhei.ttf
原文 9.29 MB · 不同字符 22

## 体积
  woff2      2.5 KB   -99.97%
  woff       3.4 KB   -99.96%
```

**9.29 MB → 2.5 KB。** 这不是压缩玄学，是确定性算法：字体里有字形表，把没用的裁掉就行。

## 两个工具

### `font_subset`

字符可以从三个地方来：

```
font_subset({ font: "simhei.ttf", text: "人工智能生成合成内容标识办法" })
font_subset({ font: "simhei.ttf", textFile: "content.md" })
font_subset({ font: "simhei.ttf", paths: ["src/", "index.html"] })
```

`paths` 会递归扫 html/vue/js/ts/css/json/md/txt，把出现过的字符全收进来——
正好对应「这个站点用到的字」这个真实需求。给 `dryRun` 就只报体积不写文件。

### `font_coverage`

只查缺字，不写文件。

```
font_coverage simhei.ttf
23 个不同字符

  缺 1 个（4.3%）：
    𠮷
```

**这个比子集化本身更重要。** 字体里没有某个字时，子集化会**静默丢掉它**，
页面上就出现豆腐块——而且是在上线之后才发现。所以在裁剪之前先查一遍。

## 实现细节

**缺字检查自己解析 cmap 表**，不依赖转换库。支持 format 4（BMP）与 format 12（BMP 之外），
优先用 12。解析不了就明说「无法判定」，不假装覆盖完整。

**压缩包装的字体读不了 cmap。** `.woff` / `.woff2` 是压缩过的，缺字检查需要 `.ttf` / `.otf` 原件，
报告里直接说清楚，不糊弄。

**压缩率不在 99% 以上谎报 100%。** 一位小数会把 -99.97% 显示成 -100.0%，那是四舍五入不是事实，
所以压到 99% 以上时保留两位。

## 安装

```
dsh plugin add github:Lee2277-t/dsh-font-subset
```

依赖 `subset-font`（harfbuzz 的 wasm 构建，不需要原生编译）。

## 配置

```yaml
formats: [woff2]      # 输出格式：woff2 / woff / ttf
outputDir: ""         # 留空则与源字体同目录
maxChars: 20000       # 不同字符数上限，超了会拒绝（字符太多时子集化已无收益）
```

## 限制

- 不支持可变字体的字重轴子集化（会把可变字体拍平）。
- 不做字体格式转换（ttf ↔ woff2 是子集化的副产品，不是本工具的用途）。
- 不判断字体授权。子集化不改变授权范围，商用字体仍需授权。

## 许可

AGPL-3.0-only。

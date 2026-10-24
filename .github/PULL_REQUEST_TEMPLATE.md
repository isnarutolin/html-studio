## 这个 PR 做了什么

<!-- 一句话说清就行 -->

## 涉及范围

- [ ] Chrome 扩展（`extension/`）
- [ ] 本地网页版（`server.py` / `ui.html`）
- [ ] 常驻服务（`service.py`）
- [ ] 文档
- [ ] 其它：

## 验证情况

跑一下这两条，把结果贴上来：

```bash
python3 -m py_compile server.py service.py extension/native_host.py extension/install.py
python3 tests/e2e_chrome.py
```

- [ ] 语法检查通过
- [ ] 端到端测试通过（`tests/e2e_chrome.py`）

如果你动了扩展目录（`extension/`），**务必**确认没有以 `_` 或 `.` 开头的文件 ——
Chrome 把这当保留名，会让整个扩展加载失败，而报错信息完全不会提到这一点：

```bash
ls -A extension | grep -E '^[_.]' && echo "✗ 有保留名，必须删掉" || echo "✓ 干净"
```

## 注意事项

<!-- 如果要改 native host 名字，请用 python3 extension/install.py --rename-host <name>，
     不要手动改 —— 这个名字硬编码在 4 个文件里，漏改一个会静默失效。 -->

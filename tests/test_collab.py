#!/usr/bin/env python3
"""
collab.py 的单元测试：只测「纯逻辑」那部分（不启 HTTP 服务、不起浏览器）。

覆盖三块最容易回归的规则：
  1. 操作合并（apply_op）—— add / reply / status / delete 的幂等与去重
  2. 身份绑定（claim_name）—— 署名先到先得，别人占用就拒
  3. 权限校验（check_permission）—— 只有作者本人能标记已解决 / 删除

用法：
  python3 tests/test_collab.py
  python3 -m pytest tests/test_collab.py -q    # 装了 pytest 也行
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import collab  # noqa: E402


def make_ann(aid="a1", author="张三", status="open", body="内容"):
    return {
        "id": aid, "createdAt": 1, "author": {"name": author},
        "anchor": {"start": 0, "end": 2, "text": "正文", "prefix": "", "suffix": ""},
        "body": body, "status": status, "replies": [],
    }


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = collab.Store(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    # ---------- 操作合并 ----------
    def test_add_is_idempotent(self):
        anns = []
        op = {"type": "add", "annotation": make_ann()}
        collab.Store.apply_op(anns, op)
        collab.Store.apply_op(anns, op)          # 重复同一 op 不应产生两条
        self.assertEqual(len(anns), 1)

    def test_reply_dedup(self):
        anns = [make_ann()]
        reply = {"id": "r1", "createdAt": 2, "author": {"name": "李四"}, "body": "收到"}
        collab.Store.apply_op(anns, {"type": "reply", "id": "a1", "reply": reply})
        collab.Store.apply_op(anns, {"type": "reply", "id": "a1", "reply": reply})
        self.assertEqual(len(anns[0]["replies"]), 1)

    def test_status_and_delete(self):
        anns = [make_ann()]
        collab.Store.apply_op(anns, {"type": "status", "id": "a1", "status": "resolved"})
        self.assertEqual(anns[0]["status"], "resolved")
        collab.Store.apply_op(anns, {"type": "delete", "id": "a1"})
        self.assertEqual(anns, [])
        # 删除不存在的 id 不应抛异常（幂等）
        collab.Store.apply_op(anns, {"type": "delete", "id": "nope"})

    def test_persist_and_reload(self):
        anns = self.store.load("doc1")
        collab.Store.apply_op(anns, {"type": "add", "annotation": make_ann()})
        self.store.persist("doc1")
        again = collab.Store(self.tmp.name)
        self.assertEqual(len(again.load("doc1")), 1)

    def test_doc_name_with_chinese(self):
        anns = self.store.load("上海和平饭店_诊断")
        collab.Store.apply_op(anns, {"type": "add", "annotation": make_ann()})
        self.store.persist("上海和平饭店_诊断")
        files = os.listdir(self.tmp.name)
        self.assertTrue(any("上海" in f and f.endswith(".json") for f in files), files)

    # ---------- 身份绑定 ----------
    def test_claim_name_first_wins(self):
        self.assertIsNone(self.store.claim_name("tokA", "张三"))
        err = self.store.claim_name("tokB", "张三")
        self.assertIsNotNone(err)
        self.assertIn("已被别人占用", err)

    def test_claim_same_token_again_ok(self):
        self.assertIsNone(self.store.claim_name("tokA", "张三"))
        self.assertIsNone(self.store.claim_name("tokA", "张三"))

    def test_claim_requires_name_and_token(self):
        self.assertIsNotNone(self.store.claim_name("tokA", "  "))
        self.assertIsNotNone(self.store.claim_name("", "张三"))

    # ---------- 权限 ----------
    def test_owner_can_delete_and_resolve(self):
        anns = [make_ann(author="张三")]
        self.store.claim_name("tokA", "张三")
        self.assertIsNone(self.store.check_permission(anns, {"type": "delete", "id": "a1"}, "tokA"))
        self.assertIsNone(self.store.check_permission(anns, {"type": "status", "id": "a1", "status": "resolved"}, "tokA"))

    def test_other_cannot_delete(self):
        anns = [make_ann(author="张三")]
        self.store.claim_name("tokA", "张三")
        self.store.claim_name("tokB", "李四")
        err = self.store.check_permission(anns, {"type": "delete", "id": "a1"}, "tokB")
        self.assertIsNotNone(err)
        self.assertIn("只有作者本人", err)

    def test_unbound_cannot_delete_legacy_annotation(self):
        """历史批注（作者尚未绑定）任何人都不能删 —— 否则拿到链接就能认领别人的批注。"""
        anns = [make_ann(author="大姐姐")]
        err = self.store.check_permission(anns, {"type": "delete", "id": "a1"}, "tokX")
        self.assertIsNotNone(err)
        self.assertIn("还没在这份稿子留过批注", err)

    def test_check_permission_ignores_add_and_reply(self):
        anns = [make_ann()]
        self.assertIsNone(self.store.check_permission(anns, {"type": "add"}, ""))
        self.assertIsNone(self.store.check_permission(anns, {"type": "reply", "id": "a1"}, ""))

    def test_missing_annotation_is_noop(self):
        self.assertIsNone(self.store.check_permission([], {"type": "delete", "id": "gone"}, "tokA"))


class DocIdTest(unittest.TestCase):
    def test_extension_less_and_encoded(self):
        self.assertEqual(collab.doc_id_for("/a/b.html"), "a_b")
        self.assertEqual(collab.doc_id_for("/a/b"), "a_b")
        self.assertEqual(collab.doc_id_for("/" + "diagnosis"), "diagnosis")
        self.assertEqual(collab.doc_id_for("/"), "index")

    def test_chinese_kept(self):
        self.assertEqual(collab.doc_id_for("/上海饭店.html"), "上海饭店")


if __name__ == "__main__":
    unittest.main(verbosity=2)

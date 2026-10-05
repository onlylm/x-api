"""Offline fixture for the one-order repair; never connects to production."""

import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "oneoff-manual-completion-20261005.py"
spec = importlib.util.spec_from_file_location("oneoff_manual_completion", SCRIPT)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class OneoffManualCompletionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        repair.DB_PATH = base / "merchant-gateway.sqlite"
        repair.BACKUP_DIR = base / "order-backups"
        repair.BACKUP_DIR.mkdir()
        db = sqlite3.connect(repair.DB_PATH)
        db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE orders (
              order_id TEXT PRIMARY KEY, client_order_id TEXT, status TEXT,
              delivery_status TEXT, refunded_at TEXT, order_source TEXT,
              quantity INTEGER, updated_at TEXT
            );
            CREATE TABLE activations (
              id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT,
              activation_id INTEGER, task_id TEXT UNIQUE, status TEXT,
              finished INTEGER, failure_code TEXT, message_zh TEXT,
              worker_state TEXT, worker_locked_until TEXT, cdk_id INTEGER,
              redemption_token TEXT, upstream_order_id TEXT,
              account_email_masked TEXT, email_hash TEXT,
              session_ciphertext TEXT, session_iv TEXT, session_tag TEXT,
              created_at TEXT, updated_at TEXT,
              UNIQUE(order_id, activation_id)
            );
            CREATE TABLE refunds (order_id TEXT);
            CREATE TABLE cdks (assigned_activation_id INTEGER);
            CREATE TABLE activation_worker_control (
              activation_id INTEGER PRIMARY KEY, attempts INTEGER,
              issue_started INTEGER, needs_review INTEGER, lease_token TEXT,
              lease_until TEXT, next_retry_at TEXT, last_stage TEXT,
              last_error_code TEXT, stage_finished_at TEXT,
              review_resumed_at TEXT, updated_at TEXT
            );
            CREATE TABLE webhook_outbox (
              id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE,
              event TEXT, payload_json TEXT, attempt_count INTEGER,
              next_attempt_at TEXT, created_at TEXT, delivered_at TEXT,
              exhausted_at TEXT
            );
            CREATE TABLE order_audit_log (
              order_id TEXT, action TEXT, from_status TEXT,
              to_status TEXT, reason TEXT, operator TEXT, created_at TEXT
            );
        """)
        db.execute(
            "INSERT INTO orders VALUES (?,?,?,NULL,NULL,?,1,?)",
            (repair.ORDER_ID, repair.CLIENT_ORDER_ID, "paid", "platform", "before"),
        )
        db.execute(
            "INSERT INTO activations "
            "(id,order_id,activation_id,task_id,status,finished,worker_state,"
            "worker_locked_until,account_email_masked,email_hash,"
            "session_ciphertext,created_at,updated_at) "
            "VALUES (490,?,1,?,'queued',0,'provisioning',?,?,?,'encrypted-session',?,?)",
            (repair.ORDER_ID, repair.TASK_ID,
             "9999-12-31T23:59:59.999Z", repair.MASKED_EMAIL,
             "test-email-hash", "before", "before"),
        )
        db.execute(
            "INSERT INTO activation_worker_control "
            "(activation_id,attempts,issue_started,needs_review,lease_token,"
            "lease_until,last_stage,last_error_code,stage_finished_at,updated_at) "
            "VALUES (490,1,1,1,NULL,NULL,'issue',"
            "'configuration_or_validation_error','finished',?)",
            (repair.EXPECTED_CONTROL_UPDATED_AT,),
        )
        db.commit()
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    def test_atomic_manual_success_and_backup(self):
        before = repair.connect_read_only()
        self.assertEqual(repair.inspect(before)["task_id"], repair.TASK_ID)
        before.close()
        repair.apply()
        db = repair.connect_read_only()
        self.assertEqual(
            db.execute("SELECT delivery_status FROM orders").fetchone()[0],
            "success",
        )
        rows = db.execute(
            "SELECT status,finished,worker_state,session_ciphertext,message_zh "
            "FROM activations ORDER BY activation_id"
        ).fetchall()
        self.assertEqual([(r[0], r[1], r[2]) for r in rows],
                         [("failed", 1, "terminal"), ("success", 1, "terminal")])
        self.assertIsNone(rows[0][3])
        self.assertEqual(rows[1][4], "人工充值完成")
        payload = json.loads(
            db.execute("SELECT payload_json FROM webhook_outbox").fetchone()[0]
        )
        self.assertEqual(payload, {
            "event": "order.activated",
            "order_id": repair.ORDER_ID,
            "client_order_id": repair.CLIENT_ORDER_ID,
        })
        self.assertEqual(
            db.execute("SELECT COUNT(*) FROM order_audit_log").fetchone()[0], 2
        )
        db.close()
        backups = list(repair.BACKUP_DIR.glob("*.sqlite"))
        self.assertEqual(len(backups), 1)
        backup = sqlite3.connect(backups[0])
        self.assertIsNone(
            backup.execute("SELECT delivery_status FROM orders").fetchone()[0]
        )
        backup.close()

    def test_changed_control_refuses_without_writes(self):
        db = sqlite3.connect(repair.DB_PATH)
        db.execute(
            "UPDATE activation_worker_control SET issue_started=0 WHERE activation_id=490"
        )
        db.commit()
        db.close()
        reader = repair.connect_read_only()
        try:
            with self.assertRaisesRegex(RuntimeError, "worker_control_precondition_changed"):
                repair.inspect(reader)
        finally:
            reader.close()
        db = repair.connect_read_only()
        self.assertEqual(
            db.execute("SELECT COUNT(*) FROM activations").fetchone()[0], 1
        )
        db.close()


if __name__ == "__main__":
    unittest.main()

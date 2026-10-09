#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kata (Katabump) 自动登录与续期脚本 (kata_renew.py)
- Python + SeleniumBase UC 原生过盾架构 (彻底突破 Cloudflare Turnstile 与 ALTCHA)
- Mihomo 智能代理池 (支持 Clash/Mihomo 订阅 / TG Socks / S5 / HTTP，延迟测速与多账号轮换)
- 真实有效期校准 (自然日归一化为北京时间 UTC+8)
- 智能决策 (有效期充裕/未到期自动校准打卡；临界自动 Renew 确认)
- Telegram 图文通知 (支持群组与话题)
"""

import os
import sys
import time
import json
import re
import random
import subprocess
import base64
from datetime import datetime, timezone, timedelta
from urllib.parse import quote, urlparse
from typing import List, Dict, Optional, Tuple

import requests
try:
    from seleniumbase import SB
except ImportError:
    SB = None

sys.stdout.reconfigure(line_buffering=True)

# ============================================================
#  1. 环境变量与配置
# ============================================================
def load_dotenv():
    env_paths = [
        ".env",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    ]
    for p in env_paths:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            os.environ[k.strip()] = v.strip()
                print(f"[配置] 已载入环境变量文件: {p}")
                break
            except Exception:
                pass

load_dotenv()

TG_BOT_TOKEN = os.getenv("TG_BOT_TOKEN", "").strip()
TG_CHAT_ID   = os.getenv("TG_CHAT_ID", "").strip()
TG_THREAD_ID = os.getenv("TG_THREAD_ID", "").strip()

PROXY_SOURCE = (
    os.getenv("SUB_URL") or
    os.getenv("PROXY_URL") or
    os.getenv("S5_URL") or
    os.getenv("HTTP_PROXY") or ""
).strip()

LOGIN_URL      = "https://dashboard.katabump.com/auth/login"
SERVER_URL_TPL = "https://dashboard.katabump.com/servers/edit?id={server_id}"
SCREENSHOT_DIR = os.path.join(os.getcwd(), "screenshots")
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

RENEW_DATES_FILE = os.path.join(os.getcwd(), "renew_dates.json")

# ============================================================
#  2. Mihomo 代理池配置
# ============================================================
_IS_MIHOMO_ENABLED = False
MIHOMO_API         = "http://127.0.0.1:9090"
MIHOMO_PORT        = 7890
MIHOMO_VERSION     = "v1.18.9"
MIHOMO_BIN         = os.path.join(os.getcwd(), "mihomo" if sys.platform != "win32" else "mihomo.exe")

# ============================================================
#  3. 工具函数与脱敏
# ============================================================
def mask_username(username: str) -> str:
    val = str(username or "").strip()
    if not val:
        return "***"
    if "@" in val:
        user_part, domain = val.rsplit("@", 1)
        if len(user_part) <= 2:
            masked = f"{user_part[0]}*"
        else:
            masked = f"{user_part[:2]}***{user_part[-1]}"
        return f"{masked}@{domain}"
    if len(val) <= 4:
        return "*" * len(val)
    return f"{val[:2]}***{val[-2:]}"


def load_renew_dates() -> Dict[str, str]:
    if os.path.exists(RENEW_DATES_FILE):
        try:
            with open(RENEW_DATES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[日期] 解析 renew_dates.json 失败: {e}")
    return {}


def save_renew_dates(dates: Dict[str, str]):
    try:
        with open(RENEW_DATES_FILE, "w", encoding="utf-8") as f:
            json.dump(dates, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[日期] 保存 renew_dates.json 失败: {e}")


def get_beijing_now_date() -> datetime:
    tz_bj = timezone(timedelta(hours=8))
    return datetime.now(tz_bj)


def format_chinese_date(date_str: str) -> str:
    if not date_str or not isinstance(date_str, str):
        return "未知"
    clean_str = re.sub(r'\s*\(in\b.*$', '', date_str.strip(), flags=re.I).strip()
    if re.match(r'^\d{4}年\d{1,2}月\d{1,2}日$', clean_str):
        return clean_str

    now_bj = get_beijing_now_date()
    target_year = now_bj.year
    target_month = None
    target_day = None

    # YYYY-MM-DD
    m_iso = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', clean_str)
    if m_iso:
        return f"{int(m_iso.group(1))}年{int(m_iso.group(2))}月{int(m_iso.group(3))}日"

    # M月D日 或 YYYY年M月D日
    m_cn = re.match(r'^(?:(\d{4})年)?\s*(\d{1,2})月(\d{1,2})日?$', clean_str)
    if m_cn:
        if m_cn.group(1):
            target_year = int(m_cn.group(1))
        return f"{target_year}年{int(m_cn.group(2))}月{int(m_cn.group(3))}日"

    # 英文月份 (如 07 September 或 07 September 2026)
    month_map = {
        'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3,
        'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7,
        'aug': 8, 'august': 8, 'sep': 9, 'september': 9, 'oct': 10, 'october': 10,
        'nov': 11, 'november': 11, 'dec': 12, 'december': 12
    }
    m_en1 = re.match(r'^(\d{1,2})\s+([a-zA-Z]+)(?:\s+(\d{4}))?$', clean_str)
    m_en2 = re.match(r'^([a-zA-Z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$', clean_str)

    if m_en1:
        target_day = int(m_en1.group(1))
        m_name = m_en1.group(2).lower()
        if m_name in month_map:
            target_month = month_map[m_name]
        if m_en1.group(3):
            target_year = int(m_en1.group(3))
    elif m_en2:
        target_day = int(m_en2.group(2))
        m_name = m_en2.group(1).lower()
        if m_name in month_map:
            target_month = month_map[m_name]
        if m_en2.group(3):
            target_year = int(m_en2.group(3))

    if target_month is not None and target_day is not None:
        return f"{target_year}年{target_month}月{target_day}日"

    return clean_str


def parse_expiry_days_left(date_str: str) -> Optional[int]:
    if not date_str or not isinstance(date_str, str) or date_str in ("未知", "已校正"):
        return None
    clean_str = re.sub(r'\s*\(in\b.*$', '', date_str.strip(), flags=re.I).strip()

    now_bj = get_beijing_now_date()
    today_midnight = datetime(now_bj.year, now_bj.month, now_bj.day)

    # 尝试匹配已转换的中文格式 YYYY年M月D日
    m_cn = re.match(r'^(\d{4})年(\d{1,2})月(\d{1,2})日$', clean_str)
    if m_cn:
        y, m, d = int(m_cn.group(1)), int(m_cn.group(2)), int(m_cn.group(3))
        try:
            target_dt = datetime(y, m, d)
            diff = (target_dt - today_midnight).days
            return diff
        except Exception:
            return None

    # 尝试 ISO 格式
    m_iso = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', clean_str)
    if m_iso:
        y, m, d = int(m_iso.group(1)), int(m_iso.group(2)), int(m_iso.group(3))
        try:
            target_dt = datetime(y, m, d)
            return (target_dt - today_midnight).days
        except Exception:
            return None

    return None


# ============================================================
#  4. Telegram 推送通知
# ============================================================
def tg_send(text: str, photo_path: Optional[str] = None) -> None:
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        print("[TG] 未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过推送")
        return
    try:
        if photo_path and os.path.exists(photo_path):
            url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendPhoto"
            data = {
                "chat_id": TG_CHAT_ID,
                "caption": text[:1024],
                "parse_mode": "HTML"
            }
            if TG_THREAD_ID:
                data["message_thread_id"] = TG_THREAD_ID
            with open(photo_path, "rb") as f:
                res = requests.post(url, data=data, files={"photo": f}, timeout=20)
                if res.status_code == 200:
                    print("[TG] ✅ 图文通知推送成功")
                    return
        # 回退纯文本
        url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
        payload = {
            "chat_id": TG_CHAT_ID,
            "text": text[:4096],
            "parse_mode": "HTML",
            "disable_web_page_preview": True
        }
        if TG_THREAD_ID:
            payload["message_thread_id"] = TG_THREAD_ID
        res = requests.post(url, json=payload, timeout=15)
        if res.status_code == 200:
            print("[TG] ✅ 消息通知推送成功")
        else:
            print(f"[TG] ⚠️ 推送返回: {res.status_code} {res.text}")
    except Exception as e:
        print(f"[TG] ❌ 推送失败: {e}")


# ============================================================
#  5. 账号凭据加载 (全能自适应提取器: 完美支持一整行、多行缩进与任意分组嵌套)
# ============================================================
def extract_account_entries(data) -> List[Dict]:
    """递归智能提取器: 支持列表、分组字典、嵌套分组及用户名键值映射"""
    results = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                u = item.get("username") or item.get("email")
                p = item.get("password")
                if u and p:
                    results.append(item)
                else:
                    # 检查是否有嵌套分组 (如 {"group": "A", "accounts": [...]})
                    results.extend(extract_account_entries(item))
            elif isinstance(item, list):
                results.extend(extract_account_entries(item))
    elif isinstance(data, dict):
        u = data.get("username") or data.get("email")
        p = data.get("password")
        if u and p:
            results.append(data)
        else:
            # 兼容分组字典: {"组A": [...], "组B": [...]} 或 {"users": [...]}
            for k, val in data.items():
                if isinstance(val, (list, dict)):
                    # 若形如 {"user@email.com": {"password": "...", "serverId": "..."}}
                    if isinstance(val, dict) and (val.get("password") or val.get("pass")):
                        rec = dict(val)
                        if "username" not in rec and "email" not in rec:
                            rec["username"] = k
                        results.append(rec)
                    else:
                        results.extend(extract_account_entries(val))
    return results


def parse_raw_accounts_text(raw_text: str) -> List[Dict]:
    """多策略解析原始凭据文本 (JSON 数组、单双引号、多层分组对象或多行文本)"""
    if not raw_text or not raw_text.strip():
        return []

    cleaned = raw_text.strip()
    # 策略 1: 尝试标准 JSON 或单引号 JSON 解析
    try:
        json_str = cleaned
        if (json_str.startswith("[") or json_str.startswith("{")) and "'" in json_str and '"' not in json_str:
            json_str = json_str.replace("'", '"')
        parsed = json.loads(json_str)
        extracted = extract_account_entries(parsed)
        if extracted:
            return extracted
    except Exception:
        pass

    # 策略 2: 纯文本按行切分 (支持 : 、---- 或 , 分隔)
    lines_entries = []
    for line in cleaned.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = []
        if "----" in line:
            parts = line.split("----")
        elif ":" in line and not line.startswith("http"):
            parts = line.split(":")
        elif "," in line:
            parts = line.split(",")
        if len(parts) >= 2:
            lines_entries.append({
                "username": parts[0].strip(),
                "password": parts[1].strip(),
                "serverId": parts[2].strip() if len(parts) > 2 else ""
            })
    return lines_entries


def get_accounts() -> List[Dict[str, str]]:
    # 严格仅使用 USERS_JSON 变量，杜绝其他杂项变量
    raw_users = os.getenv("USERS_JSON", "").strip()

    entries = []
    if raw_users:
        entries = parse_raw_accounts_text(raw_users)

    # 若未配置环境变量 USERS_JSON，回退至本地文件 login.json 兜底
    if not entries:
        if os.path.exists("login.json"):
            try:
                with open("login.json", "r", encoding="utf-8") as f:
                    c = f.read().strip()
                    if c:
                        found = parse_raw_accounts_text(c)
                        if found:
                            print(f"[用户配置] 从本地文件 login.json 加载账号 (提取到 {len(found)} 条，兼容单行与分组格式)...")
                            entries = found
            except Exception as e:
                print(f"[用户配置] 读取 login.json 出错: {e}")

    accounts: List[Dict[str, str]] = []
    seen = set()
    for item in entries:
        if not isinstance(item, dict):
            continue
        u = str(item.get("username") or item.get("email") or item.get("user") or "").strip()
        p = str(item.get("password") or item.get("pass") or "").strip()
        s = str(item.get("serverId") or item.get("server_id") or item.get("id") or "").strip()
        if not u or not p:
            continue
        dedupe = u.lower()
        if dedupe in seen:
            continue
        seen.add(dedupe)
        accounts.append({"username": u, "password": p, "serverId": s})

    print(f"[用户配置] 共解析出 {len(accounts)} 个有效账号")
    return accounts


# ============================================================
#  6. Mihomo 智能代理池引擎
# ============================================================
def _download_mihomo() -> Optional[str]:
    if os.path.exists(MIHOMO_BIN):
        print(f"[代理池] 检测到现有 Mihomo: {MIHOMO_BIN}")
        return MIHOMO_BIN

    print(f"[代理池] 正在下载 Mihomo {MIHOMO_VERSION}...")
    if sys.platform == "win32":
        zip_url = f"https://github.com/MetaCubeX/mihomo/releases/download/{MIHOMO_VERSION}/mihomo-windows-amd64-{MIHOMO_VERSION}.zip"
        try:
            import zipfile
            subprocess.run(["curl", "-L", "-o", "mihomo.zip", zip_url], check=True, timeout=120)
            with zipfile.ZipFile("mihomo.zip", "r") as z:
                for fname in z.namelist():
                    if fname.endswith(".exe"):
                        with open(MIHOMO_BIN, "wb") as f_out:
                            f_out.write(z.read(fname))
                        break
            print("[代理池] Windows 版 Mihomo 安装就绪")
            return MIHOMO_BIN
        except Exception as e:
            print(f"[代理池] 下载失败: {e}")
            return None
    else:
        gz_url = f"https://github.com/MetaCubeX/mihomo/releases/download/{MIHOMO_VERSION}/mihomo-linux-amd64-{MIHOMO_VERSION}.gz"
        try:
            subprocess.run(["curl", "-L", "-o", "mihomo.gz", gz_url], check=True, timeout=120)
            subprocess.run(["gzip", "-d", "mihomo.gz"], check=True, timeout=30)
            subprocess.run(["chmod", "+x", MIHOMO_BIN], check=True)
            print("[代理池] Linux 版 Mihomo 安装就绪")
            return MIHOMO_BIN
        except Exception as e:
            print(f"[代理池] 下载失败: {e}")
            return None


def _build_config_subscription(sub_url: str) -> str:
    return f"""mixed-port: {MIHOMO_PORT}
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090

proxy-providers:
  sub1:
    type: http
    url: "{sub_url}"
    interval: 3600
    path: ./sub1.yaml
    headers:
      User-Agent: ["clash-meta/{MIHOMO_VERSION} Mozilla/5.0"]
    health-check:
      enable: true
      interval: 600
      url: http://www.gstatic.com/generate_204

proxy-groups:
  - name: MyGroup
    type: select
    use:
      - sub1

rules:
  - MATCH,MyGroup
"""


def _parse_s5_text(raw: str) -> List[Dict]:
    lines = raw.splitlines()
    proxies: List[Dict] = []
    seen_names = set()
    current_label = ""

    def unique_name(base: str) -> str:
        n = re.sub(r'[:\[\]{},&*#?|<>=!%@\\]', '_', base or f"Proxy-{len(proxies)+1}").strip()
        final, c = n, 1
        while final in seen_names:
            final = f"{n}-{c}"
            c += 1
        seen_names.add(final)
        return final

    for line in lines:
        line = line.strip()
        if not line:
            continue
        if re.match(r'^(\d+[\.、]\s*|【)', line):
            current_label = re.sub(r'^\d+[\.、]\s*', '', line).replace("【", "").replace("】", "").strip()
            continue
        if line.startswith(("https://t.me/socks?", "tg://socks?")):
            try:
                parsed = urlparse(line.replace("tg://socks?", "https://dummy.com/socks?"))
                qs = dict(urllib.parse.parse_qsl(parsed.query))
                server = qs.get("server")
                port = int(qs.get("port", 0))
                if server and port:
                    node = {
                        "name": unique_name(current_label or f"TG-S5-{server}:{port}"),
                        "type": "socks5",
                        "server": server,
                        "port": port,
                        "udp": True,
                        "skip-cert-verify": True
                    }
                    if qs.get("user") or qs.get("username"):
                        node["username"] = qs.get("user") or qs.get("username")
                    if qs.get("pass") or qs.get("password"):
                        node["password"] = qs.get("pass") or qs.get("password")
                    proxies.append(node)
                    current_label = ""
                    continue
            except Exception:
                pass
        if line.startswith("socks5://") or line.startswith("socks://"):
            try:
                parsed = urlparse(line)
                node = {
                    "name": unique_name(current_label or f"S5-{parsed.hostname}:{parsed.port}"),
                    "type": "socks5",
                    "server": parsed.hostname,
                    "port": parsed.port or 1080,
                    "udp": True,
                    "skip-cert-verify": True
                }
                if parsed.username: node["username"] = urllib.parse.unquote(parsed.username)
                if parsed.password: node["password"] = urllib.parse.unquote(parsed.password)
                proxies.append(node)
                current_label = ""
                continue
            except Exception:
                pass
        m_ip = re.match(r'^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)(?::([^:]+):([^:]+))?', line)
        if m_ip:
            node = {
                "name": unique_name(current_label or f"S5-{m_ip.group(1)}:{m_ip.group(2)}"),
                "type": "socks5",
                "server": m_ip.group(1),
                "port": int(m_ip.group(2)),
                "udp": True,
                "skip-cert-verify": True
            }
            if m_ip.group(3): node["username"] = m_ip.group(3)
            if m_ip.group(4): node["password"] = m_ip.group(4)
            proxies.append(node)
            current_label = ""
            continue

    return proxies


def _build_config_nodes(nodes: List[Dict]) -> str:
    yaml = f"""mixed-port: {MIHOMO_PORT}
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090

proxies:
"""
    for p in nodes:
        yaml += f'  - name: "{p["name"]}"\n'
        yaml += f'    type: {p["type"]}\n'
        yaml += f'    server: "{p["server"]}"\n'
        yaml += f'    port: {p["port"]}\n'
        if p.get("username"): yaml += f'    username: "{p["username"]}"\n'
        if p.get("password"): yaml += f'    password: "{p["password"]}"\n'
        if p.get("tls"):      yaml += f'    tls: true\n'
        if p.get("udp"):      yaml += f'    udp: true\n'
        yaml += f'    skip-cert-verify: true\n'

    yaml += "\nproxy-groups:\n  - name: MyGroup\n    type: select\n    proxies:\n"
    for p in nodes:
        yaml += f'      - "{p["name"]}"\n'
    yaml += "\nrules:\n  - MATCH,MyGroup\n"
    return yaml


def _start_mihomo() -> bool:
    global _IS_MIHOMO_ENABLED
    try:
        subprocess.run([MIHOMO_BIN, "-d", os.getcwd(), "-f", "config.yaml", "-t"], capture_output=True, check=True, timeout=10)
    except Exception as e:
        print(f"[代理池] config.yaml 测试失败: {e}")
        return False

    with open("mihomo.log", "w", encoding="utf-8") as log:
        subprocess.Popen([MIHOMO_BIN, "-d", os.getcwd(), "-f", "config.yaml"], stdout=log, stderr=log)
    print("[代理池] Mihomo 进程已启动，等待 5 秒就绪...")
    time.sleep(5)
    _IS_MIHOMO_ENABLED = True
    return True


def _get_proxy_names() -> List[str]:
    for _ in range(4):
        try:
            res = requests.get(f"{MIHOMO_API}/proxies/MyGroup", timeout=5)
            names = res.json().get("all", [])
            filtered = [n for n in names if n not in ("DIRECT", "REJECT", "MyGroup")]
            if filtered:
                return filtered
            time.sleep(2)
        except Exception:
            time.sleep(2)
    return []


def _test_proxies(names: List[str]) -> List[str]:
    print(f"\n[代理池] 对 {len(names)} 个节点进行延迟测速...")
    healthy_with_delay = []
    for name in names:
        try:
            res = requests.get(
                f"{MIHOMO_API}/proxies/{quote(name, safe='')}/delay?timeout=3500&url=http://www.gstatic.com/generate_204",
                timeout=4.5
            )
            delay = res.json().get("delay")
            if isinstance(delay, (int, float)):
                print(f"   ✅ {name:<35} {delay}ms")
                healthy_with_delay.append((name, int(delay)))
                continue
        except Exception:
            pass
        print(f"   ❌ {name}")

    healthy_with_delay.sort(key=lambda x: x[1])
    healthy = [n for n, _ in healthy_with_delay]
    print(f"[代理池] 🏁 测速完成: 存活 {len(healthy)} 个 / 失效 {len(names) - len(healthy)} 个\n")
    return healthy


def switch_proxy(name: str) -> bool:
    try:
        requests.put(f"{MIHOMO_API}/proxies/MyGroup", json={"name": name}, timeout=3)
        print(f"[代理池] 🚀 成功切换节点: {name}")
        return True
    except Exception as e:
        print(f"[代理池] 切换节点失败 {name}: {e}")
        return False


def setup_proxy_pool(proxy_source: str) -> List[str]:
    if not proxy_source:
        return []
    mpath = _download_mihomo()
    if not mpath:
        return []

    is_url = bool(re.match(r'^https?://', proxy_source, re.I))
    raw_content = ""
    is_clash_yaml = False

    print(f"\n[智能代理] 🔍 正在嗅探代理源 ({'远程链接' if is_url else '内联文本'})...")
    if is_url:
        try:
            res = requests.get(proxy_source, timeout=15, headers={
                "User-Agent": f"clash-meta/{MIHOMO_VERSION} Mozilla/5.0"
            })
            raw_content = res.text
            if any(k in raw_content for k in ("proxies:", "proxy-providers:", "rules:")):
                is_clash_yaml = True
        except Exception as e:
            print(f"[智能代理] 探测远程地址异常: {e}，回退 Provider 模式")
            is_clash_yaml = True
    else:
        raw_content = proxy_source

    if is_clash_yaml and is_url:
        print("[智能代理] 识别为 Clash/Mihomo 订阅链接，以 Provider 模式挂载...")
        with open("config.yaml", "w", encoding="utf-8") as f:
            f.write(_build_config_subscription(proxy_source))
        if not _start_mihomo():
            return []
        try:
            requests.put(f"{MIHOMO_API}/providers/proxies/sub1", timeout=10)
            time.sleep(2)
        except Exception:
            pass
        names = _get_proxy_names()
        return _test_proxies(names) if names else []

    nodes = []
    if raw_content:
        try:
            padded = raw_content.strip() + "=" * ((4 - len(raw_content.strip()) % 4) % 4)
            decoded = base64.b64decode(padded).decode("utf-8")
            if "://" in decoded or "server=" in decoded:
                raw_content = decoded
        except Exception:
            pass
        nodes = _parse_s5_text(raw_content)

    if nodes:
        print(f"[智能代理] 解析出 {len(nodes)} 个节点，内联 proxies 模式启动...")
        with open("config.yaml", "w", encoding="utf-8") as f:
            f.write(_build_config_nodes(nodes))
        if not _start_mihomo():
            return []
        names = _get_proxy_names()
        return _test_proxies(names) if names else []

    print("[智能代理] ⚠️ 未能识别有效节点，降级直连")
    return []


# ============================================================
#  7. Cloudflare Turnstile 与验证码穿透引擎
# ============================================================
def ts_exists(sb) -> bool:
    try:
        return sb.execute_script("""
            return !!(
                document.querySelector('input[name="cf-turnstile-response"]') ||
                document.querySelector('.cf-turnstile') ||
                document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                document.querySelector('iframe[src*="turnstile"]')
            );
        """)
    except Exception:
        return False


def ts_solved(sb) -> bool:
    try:
        return sb.execute_script("""
            var i = document.querySelector('input[name="cf-turnstile-response"]');
            return !!(i && i.value && i.value.length > 20);
        """)
    except Exception:
        return False


def expand_turnstile(sb) -> None:
    try:
        sb.execute_script("""
            (function() {
                var ti = document.querySelector('input[name="cf-turnstile-response"]');
                if (ti) {
                    var el = ti;
                    for (var i = 0; i < 20; i++) {
                        el = el.parentElement;
                        if (!el) break;
                        var s = window.getComputedStyle(el);
                        if (s.overflow === 'hidden') el.style.overflow = 'visible';
                        el.style.minWidth = 'max-content';
                    }
                }
                document.querySelectorAll('.cf-turnstile').forEach(function(c) {
                    c.style.overflow = 'visible';
                    c.style.width = '300px';
                    c.style.height = '65px';
                });
                document.querySelectorAll('iframe').forEach(function(f) {
                    if (f.src && f.src.includes('challenges.cloudflare.com')) {
                        f.style.width = '300px';
                        f.style.height = '65px';
                        f.style.visibility = 'visible';
                        f.style.opacity = '1';
                    }
                });
            })();
        """)
    except Exception:
        pass


def handle_turnstile(sb, timeout: int = 40) -> bool:
    if not ts_exists(sb):
        return True

    print("[过盾] 检测到 Cloudflare Turnstile 验证盾，尝试原生穿透...")
    try:
        sb.uc_gui_handle_captcha()
        if ts_solved(sb):
            print("[过盾] ✅ Turnstile 令牌已生成 (uc_gui_handle_captcha)")
            return True
    except Exception:
        pass

    start = time.time()
    last_click = 0
    while time.time() - start < timeout:
        if ts_solved(sb):
            print("[过盾] ✅ Turnstile 验证通过，已拿到响应令牌！")
            return True
        if not ts_exists(sb):
            print("[过盾] ✅ Turnstile 元素已完成校验")
            return True

        expand_turnstile(sb)

        now = time.time()
        if now - last_click > 3.5:
            clicked = False
            # 尝试穿透 iframe
            try:
                iframes = sb.driver.find_elements("css selector", "iframe")
                for iframe in iframes:
                    try:
                        sb.driver.switch_to.frame(iframe)
                        for sel in ["input[type='checkbox']", "label.cb-lb", ".cb-lb", "#challenge-stage"]:
                            try:
                                el = sb.driver.find_element("css selector", sel)
                                if el.is_displayed():
                                    el.click()
                                    clicked = True
                                    print(f"[过盾] 在 iframe 内部触发点击: {sel}")
                                    break
                            except Exception:
                                pass
                        if clicked:
                            break
                    except Exception:
                        pass
                    finally:
                        sb.driver.switch_to.default_content()
            except Exception:
                pass
            finally:
                try:
                    sb.driver.switch_to.default_content()
                except Exception:
                    pass

            if not clicked:
                try:
                    sb.uc_gui_click_captcha()
                    print("[过盾] 已触发 uc_gui_click_captcha 点击")
                except Exception:
                    pass

            last_click = now

        time.sleep(1.5)

    if ts_solved(sb):
        return True

    print("[过盾] ⚠️ Turnstile 验证等待超时")
    return False


def handle_altcha_in_modal(sb, timeout: int = 15) -> bool:
    """如果弹窗中存在 ALTCHA 验证组件，自动点击并等待 PoW 哈希计算"""
    try:
        has_altcha = sb.execute_script("return !!document.querySelector('altcha-widget');")
        if not has_altcha:
            return True
        print("[ALTCHA] 模态框中检测到 ALTCHA 组件，正在触发验证...")
        sb.execute_script("""
            var w = document.querySelector('altcha-widget');
            if (w && w.shadowRoot) {
                var cb = w.shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]');
                if (cb && !cb.checked) cb.click();
            }
        """)
        start = time.time()
        while time.time() - start < timeout:
            solved = sb.execute_script("""
                var w = document.querySelector('altcha-widget');
                var inp = document.querySelector('input[name="altcha"]');
                var state = w ? (w.state || w.getAttribute('state') || '') : '';
                return (state === 'verified' || (inp && inp.value && inp.value.length > 0));
            """)
            if solved:
                print("[ALTCHA] ✅ ALTCHA 验证通过！")
                return True
            time.sleep(1)
    except Exception as e:
        print(f"[ALTCHA] 处理异常: {e}")
    return True


# ============================================================
#  8. 单账号登录与续期核心执行
# ============================================================
def execute_account_flow(
    account: Dict[str, str],
    used_node: str,
    proxy_url: Optional[str] = None
) -> Dict:
    username  = account["username"]
    password  = account["password"]
    server_id = account.get("serverId", "").strip()
    safe_user = mask_username(username)
    safe_file = re.sub(r'[^a-zA-Z0-9]', '_', username)

    result = {
        "success": False,
        "is_skipped": False,
        "reason": "未知原因",
        "actual_expiry": "未知",
        "days_left": "未知",
        "screenshot": None,
        "node": used_node
    }

    print(f"\n[执行] 启动 SeleniumBase UC 浏览器环境 (代理: {used_node})...")

    sb_kwargs = {
        "uc": True,
        "locale_code": "en",
        "test": True,
        "xvfb": True,
    }
    if proxy_url:
        sb_kwargs["proxy"] = proxy_url

    with SB(**sb_kwargs) as sb:
        # 1. 访问登录页面
        print(f"[登录] 访问登录页: {LOGIN_URL}")
        try:
            sb.uc_open_with_reconnect(LOGIN_URL, reconnect_time=4.0)
            time.sleep(2)
        except Exception as e:
            print(f"[登录] 打开登录页异常: {e}")

        # 2. 检查并输入凭据
        try:
            sb.wait_for_element_visible('input[name="email"], input[type="email"], #email', timeout=25)
        except Exception:
            path = os.path.join(SCREENSHOT_DIR, f"{safe_file}_not_login_page.png")
            sb.save_screenshot(path)
            result["reason"] = "登录页未正常渲染 (网络可能被阻断)"
            result["screenshot"] = path
            return result

        print(f"[登录] 输入账号: {safe_user}")
        sb.clear('input[name="email"], input[type="email"], #email')
        sb.type('input[name="email"], input[type="email"], #email', username)

        sb.clear('input[name="password"], input[type="password"], #password')
        sb.type('input[name="password"], input[type="password"], #password', password)
        time.sleep(1)

        # 3. 提交前过盾
        handle_turnstile(sb, timeout=30)

        print("[登录] 点击 Login 按钮提交登录...")
        try:
            sb.click('button[type="submit"], button:contains("Login")')
        except Exception:
            sb.execute_script("document.querySelector('button[type=\"submit\"]').click();")

        # 4. 等待登录反馈与跳转 (最多 15 秒)
        print("[登录] 等待登录反馈与跳转 (最多 15 秒)...")
        login_success = False
        login_failed_credential = False

        for _ in range(15):
            time.sleep(1)
            cur_url = (sb.get_current_url() or "").lower()

            # 检查是否有密码错误提示
            body_text = (sb.get_text("body") or "").lower()
            if "incorrect password or no account" in body_text:
                login_failed_credential = True
                break

            # 若提示需要验证码，再次过盾并点击
            if "please complete captcha" in body_text or "please complete the captcha" in body_text:
                print("[登录] 提示请完成验证码，尝试二次穿透...")
                handle_turnstile(sb, timeout=20)
                try:
                    sb.click('button[type="submit"], button:contains("Login")')
                except Exception:
                    pass
                time.sleep(2)

            # 检查是否成功离开登录页
            if "/auth/login" not in cur_url and "/login" not in cur_url:
                login_success = True
                print(f"[登录] ✅ 登录成功！页面已跳转至: {cur_url}")
                break

            # 检查后台元素
            if sb.is_element_visible('a:contains("See")') or sb.is_element_visible('a[href*="logout"]'):
                login_success = True
                print("[登录] ✅ 检测到控制台标志元素，登录成功！")
                break

        if login_failed_credential:
            path = os.path.join(SCREENSHOT_DIR, f"{safe_file}_pwd_error.png")
            sb.save_screenshot(path)
            result["reason"] = "账号或密码错误"
            result["screenshot"] = path
            return result

        if not login_success:
            path = os.path.join(SCREENSHOT_DIR, f"{safe_file}_login_failed.png")
            sb.save_screenshot(path)
            result["reason"] = "登录超时 (CF 盾未通过或网络卡顿)"
            result["screenshot"] = path
            return result

        # 5. 进入服务器页面
        if server_id:
            target_server_url = SERVER_URL_TPL.format(server_id=server_id)
            print(f"[服务器] 通过 Server ID ({server_id}) 直接访问: {target_server_url}")
            sb.open(target_server_url)
            time.sleep(3)
        else:
            print("[服务器] 未指定 Server ID，寻找 'See' 链接进入...")
            try:
                sb.click('a:contains("See")')
                time.sleep(3)
            except Exception as e:
                path = os.path.join(SCREENSHOT_DIR, f"{safe_file}_no_see_btn.png")
                sb.save_screenshot(path)
                result["reason"] = f"未找到服务器详情链接: {e}"
                result["screenshot"] = path
                return result

        # 6. 读取服务器到期时间与状态
        print("[服务器] 正在读取页面实际到期时间...")
        body_text = sb.get_text("body") or ""

        # 匹配到期时间
        actual_expiry = None
        m_exp = re.search(r'Expiry\s*[\n\r]*\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\s+[a-zA-Z]+(?:\s+[0-9]{4})?)', body_text, re.I)
        if m_exp:
            actual_expiry = format_chinese_date(m_exp.group(1).strip())
            result["actual_expiry"] = actual_expiry
            print(f"[服务器] 识别到实际 Expiry 到期时间: {actual_expiry}")

        # 检查是否包含不能续期提示
        is_not_time_yet = "you can't renew your server yet" in body_text.lower()
        days_left = parse_expiry_days_left(actual_expiry)
        result["days_left"] = days_left if days_left is not None else "未知"

        # 判断是否无需续期（有效期充裕 > 1 天，或者明确提示不能续期）
        is_safe_expiry = (days_left is not None and days_left > 1)
        if is_not_time_yet or is_safe_expiry:
            status_desc = "有效期充裕" if is_safe_expiry else "未到续期时间"
            print(f"[智能决策] 账号 {safe_user}: {status_desc} (还剩 {result['days_left']} 天，到期: {actual_expiry})，自动校准并打卡。")
            path = os.path.join(SCREENSHOT_DIR, f"{safe_file}_status.png")
            sb.save_screenshot(path)
            result["success"] = True
            result["is_skipped"] = True
            result["reason"] = status_desc
            result["screenshot"] = path
            return result

        # 7. 临界状态：执行 Renew 续期按钮与确认弹窗
        print(f"[续期] 账号 {safe_user} 临近到期 (还剩 {result['days_left']} 天)，正在执行续期...")
        renew_clicked = False
        try:
            if sb.is_element_visible('button:contains("Renew")'):
                sb.click('button:contains("Renew")')
                renew_clicked = True
                print("[续期] 已点击主界面 Renew 按钮，等待确认模态框...")
                time.sleep(2)
        except Exception as e:
            print(f"[续期] 点击主界面 Renew 按钮异常: {e}")

        if not renew_clicked:
            path = os.path.join(SCREENSHOT_DIR, f"{safe_file}_renew_btn_not_found.png")
            sb.save_screenshot(path)
            result["reason"] = "未找到 Renew 按钮"
            result["screenshot"] = path
            return result

        # 等待模态弹窗
        modal_visible = False
        for _ in range(8):
            if sb.is_element_visible('.modal-content, [role="dialog"], div:contains("extend the life")'):
                modal_visible = True
                break
            time.sleep(1)

        if not modal_visible:
            path = os.path.join(SCREENSHOT_DIR, f"{safe_file}_modal_not_open.png")
            sb.save_screenshot(path)
            result["reason"] = "模态确认弹窗未弹出"
            result["screenshot"] = path
            return result

        # 检查模态弹窗内的验证码 (Turnstile 或 ALTCHA)
        handle_altcha_in_modal(sb)
        handle_turnstile(sb, timeout=15)

        # 截图模态框状态
        path_modal = os.path.join(SCREENSHOT_DIR, f"{safe_file}_modal_confirm.png")
        sb.save_screenshot(path_modal)

        # 点击模态框内的确认 Renew 按钮
        print("[续期] 点击模态框内部 Renew 确认按钮...")
        try:
            sb.execute_script("""
                var modal = document.querySelector('.modal-content, [role="dialog"]');
                if (modal) {
                    var btns = Array.from(modal.querySelectorAll('button'));
                    var rBtn = btns.find(b => b.textContent && b.textContent.includes('Renew'));
                    if (rBtn) rBtn.click();
                }
            """)
        except Exception:
            sb.click('.modal-content button:contains("Renew")')

        time.sleep(6)

        # 重新读取续期后的到期时间
        body_text_after = sb.get_text("body") or ""
        m_exp_after = re.search(r'Expiry\s*[\n\r]*\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\s+[a-zA-Z]+(?:\s+[0-9]{4})?)', body_text_after, re.I)
        if m_exp_after:
            new_expiry = format_chinese_date(m_exp_after.group(1).strip())
            result["actual_expiry"] = new_expiry
            new_days = parse_expiry_days_left(new_expiry)
            result["days_left"] = new_days if new_days is not None else "未知"
            print(f"[续期] ✅ 续期成功！最新到期时间: {new_expiry} (还剩 {result['days_left']} 天)")

        path_ok = os.path.join(SCREENSHOT_DIR, f"{safe_file}_renew_success.png")
        sb.save_screenshot(path_ok)
        result["success"] = True
        result["is_skipped"] = False
        result["reason"] = "续期成功"
        result["screenshot"] = path_ok
        return result


# ============================================================
#  9. 主入口
# ============================================================
def main():
    print("=" * 65)
    print("  Kata (Katabump) 自动登录与续期系统  kata_renew.py")
    print("  底层引擎: Python + SeleniumBase UC 模式 (原生穿透 Turnstile)")
    print("=" * 65)

    accounts = get_accounts()
    if not accounts:
        print("[错误] 未找到任何有效账号，退出。")
        sys.exit(1)

    # 1. 初始化智能代理池
    proxy_pool: List[str] = []
    proxy_index: int = 0
    if PROXY_SOURCE:
        proxy_pool = setup_proxy_pool(PROXY_SOURCE)
        if proxy_pool:
            print(f"[代理池] 🚀 健康节点池就绪 (共 {len(proxy_pool)} 个有效节点)，账号轮换！")
        else:
            print("[代理池] ⚠️ 无有效代理节点，降级使用本机直连")

    proxy_arg = f"http://127.0.0.1:{MIHOMO_PORT}" if (_IS_MIHOMO_ENABLED and proxy_pool) else None

    renew_dates = load_renew_dates()
    total = len(accounts)
    success_count = 0
    skipped_count = 0
    failed_count  = 0
    failed_list   = []

    # 2. 遍历执行每个账号
    for idx, acc in enumerate(accounts, 1):
        username  = acc["username"]
        safe_user = mask_username(username)
        dedupe    = username.lower()

        print(f"\n{'=' * 65}")
        print(f"  [{idx}/{total}] 正在处理账号: {safe_user}")
        print(f"{'=' * 65}")

        max_attempts = 4 if len(proxy_pool) > 1 else 2
        acc_done = False

        for attempt in range(1, max_attempts + 1):
            used_node = "DIRECT"
            if proxy_pool:
                used_node = proxy_pool[proxy_index % len(proxy_pool)]
                proxy_index += 1
                switch_proxy(used_node)
                time.sleep(1)

            if attempt > 1:
                print(f"[重试] 账号 {safe_user} 开始第 {attempt}/{max_attempts} 次尝试 (节点: {used_node})...")

            res = execute_account_flow(acc, used_node, proxy_url=proxy_arg)

            if res["success"]:
                acc_done = True
                exp_date = res["actual_expiry"]
                days_left = res["days_left"]

                if exp_date != "未知":
                    renew_dates[dedupe] = exp_date
                    save_renew_dates(renew_dates)

                if res["is_skipped"]:
                    skipped_count += 1
                    msg = (
                        f"🔄 <b>[@s5gydl] {safe_user}</b>\n"
                        f"校正日期成功 ({res['reason']})\n"
                        f"📅 实际有效期: <code>{exp_date}</code> (还剩 {days_left} 天)\n"
                        f"🌐 节点: <code>{used_node}</code>"
                    )
                else:
                    success_count += 1
                    msg = (
                        f"✅ <b>[@s5gydl] {safe_user}</b>\n"
                        f"续期成功！\n"
                        f"📅 最新有效期: <code>{exp_date}</code> (还剩 {days_left} 天)\n"
                        f"🌐 节点: <code>{used_node}</code>"
                    )

                print(msg)
                tg_send(msg, res.get("screenshot"))
                break

            # 若账号密码错误，不再重试
            if res["reason"] == "账号或密码错误":
                acc_done = True
                failed_count += 1
                failed_list.append(username)
                msg = (
                    f"❌ <b>[@s5gydl] {safe_user}</b>\n"
                    f"执行失败: 账号或密码错误\n"
                    f"🌐 节点: <code>{used_node}</code>"
                )
                print(msg)
                tg_send(msg, res.get("screenshot"))
                break

            print(f"[重试判断] 尝试 {attempt} 未成功: {res['reason']}")

        if not acc_done:
            failed_count += 1
            failed_list.append(username)
            msg = (
                f"❌ <b>[@s5gydl] {safe_user}</b>\n"
                f"多次尝试均失败 (CF 验证或页面超时)\n"
                f"🌐 节点: <code>{used_node}</code>"
            )
            print(msg)
            tg_send(msg, res.get("screenshot"))

        # 账号间随机冷却，避免并发过频
        if idx < total:
            gap = random.randint(6, 12)
            print(f"[冷却] 等待 {gap} 秒后处理下一个账号...")
            time.sleep(gap)

    # 3. 汇总报告推送
    summary_msg = (
        f"📊 <b>Kata 服务器续期任务完成汇报</b>\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"👥 总计账号: <b>{total}</b> 个\n"
        f"✅ 续期成功: <b>{success_count}</b> 个\n"
        f"🔄 校正跳过: <b>{skipped_count}</b> 个\n"
        f"❌ 执行失败: <b>{failed_count}</b> 个\n"
        f"⏰ 执行时间: <code>{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</code>"
    )
    if failed_list:
        summary_msg += f"\n⚠️ 失败账号: <code>{', '.join([mask_username(u) for u in failed_list])}</code>"

    print("\n" + "=" * 65)
    print(summary_msg)
    print("=" * 65)
    tg_send(summary_msg)


if __name__ == "__main__":
    main()

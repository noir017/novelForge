"""Novel Forge 自动驾驶：经 drv.mjs 的状态目录操作独立版服务。

前提：drv.mjs 已在后台跑着（同一个 --state）。所有子命令只读写状态目录里的文件，
真正的收发由 drv.mjs 完成。

  python nf.py [--state DIR] status
  python nf.py send '<json>'                  # 原样发一条 InMessage
  python nf.py answer [proceed|skip]          # 回答全部未决的弹窗 / 权限卡片
  python nf.py next                           # 按一下主按钮（发 pipeline.next 那一步）
  python nf.py idea "一句话" [--chapters 100] [--words 3000]
  python nf.py settings                       # 工程页「补齐设定」：前提 / 角色图谱 / 世界观
  python nf.py outline                        # 情节大纲一段段续写，直到覆盖全书
  python nf.py plots [--from 1] [--to N]      # 工程页「批量拆细纲」
  python nf.py write [--to N] [--review]      # 批量写章（写完即定稿），停了就补、接着下一批
  python nf.py wait                           # 等工程页的长任务跑完
"""
import argparse, json, os, re, sys, time

STATE = None
MODEL = None


def P(f):
    return os.path.join(STATE, f)


def load(f, dflt=None):
    try:
        with open(P(f), encoding='utf8') as fh:
            return json.load(fh)
    except Exception:
        return dflt


def send(m):
    with open(P('cmd.jsonl'), 'a', encoding='utf8') as fh:
        fh.write(json.dumps(m, ensure_ascii=False) + '\n')


def say(*a):
    print(time.strftime('%X'), *a, flush=True)


def project_root():
    ws = load('last-workspaces.json') or {}
    root = ws.get('currentId')
    if not root:
        sys.exit('服务里没有打开的工程：先在网页里打开文件夹，或 send {"type":"openFolder","path":"..."}')
    return root


def nf(*parts):
    return os.path.join(project_root(), '.novelforge', *parts)


def book_config():
    """config.md 的 frontmatter：totalChapters / wordsPerChapter。"""
    try:
        text = open(nf('config.md'), encoding='utf8').read()
    except OSError:
        return {}
    m = re.match(r'---\n(.*?)\n---', text, re.S)
    out = {}
    for line in (m.group(1).splitlines() if m else []):
        k, _, v = line.partition(':')
        if v.strip().isdigit():
            out[k.strip()] = int(v.strip())
    return out


def chapters_dir():
    # 章节根默认 chapters/；设置里改过的话以 ~/.novelforge/config.json 的 chaptersDir 为准。
    cfg = {}
    try:
        cfg = json.load(open(os.path.expanduser('~/.novelforge/config.json'), encoding='utf8'))
    except Exception:
        pass
    return os.path.join(project_root(), cfg.get('chaptersDir') or 'chapters')


def chapter_files():
    d = chapters_dir()
    return sorted(f for f in os.listdir(d) if re.match(r'\d+', f)) if os.path.isdir(d) else []


def next_chapter_no():
    nos = {int(re.match(r'\d+', f).group()) for f in chapter_files()}
    n = 1
    while n in nos:
        n += 1
    return n


def outline_coverage():
    try:
        text = open(nf('outline.md'), encoding='utf8').read()
    except OSError:
        return 0
    nums = [int(x) for h in re.findall(r'^##\s*第\s*([\d\s–\-—~～至到]+)\s*章', text, re.M) for x in re.findall(r'\d+', h)]
    return max(nums, default=0)


def char_count(path):
    text = open(path, encoding='utf8', errors='replace').read()
    text = re.sub(r'^---\n.*?\n---\n', '', text, flags=re.S)
    return len(re.sub(r'\s', '', text))


# ---- 等待与回答 ----

def answer_all(verdict='proceed', log_only_types=()):
    """回答全部未决：gate→verdict；confirm→yes（skip 时取消）；pick→第一项；input→取消。"""
    n = 0
    for p in load('pending.json', []):
        brief = (p.get('message') or '') + ' ' + (p.get('detail') or p.get('value') or '')
        say('answer', p['type'], p.get('title'), '|', brief.replace('\n', ' ')[:300])
        if p['type'] == 'gate':
            send({'type': 'gateResult', 'requestId': p['requestId'], 'verdict': verdict})
        elif p['kind'] == 'confirm':
            send({'type': 'promptResult', 'requestId': p['requestId'], **({'value': 'yes'} if verdict == 'proceed' else {})})
        elif p['kind'] == 'pick' and verdict == 'proceed':
            send({'type': 'promptResult', 'requestId': p['requestId'], 'value': (p.get('options') or [''])[0]})
        else:
            send({'type': 'promptResult', 'requestId': p['requestId']})
        n += 1
        time.sleep(1.5)
    return n


def wait_pending(timeout=900):
    """发了一次对话页生成之后，等那张「写入」卡片出来。卡片出不来（生成失败）就在 busy 落回 false 后返回。"""
    t0 = time.time()
    time.sleep(5)
    while time.time() - t0 < timeout:
        if load('pending.json', []):
            return True
        if load('busy.json') is False and time.time() - t0 > 15:
            time.sleep(3)
            return bool(load('pending.json', []))
        time.sleep(3)
    return False


def wait_tasks(auto=True, idle_rounds=3):
    """等工程页长任务跑完；途中的弹窗自动答「继续」。"""
    idle = 0
    while idle < idle_rounds:
        if auto:
            answer_all()
        if load('tasks.json', []):
            t = load('tasks.json')[0]
            idle = 0
            sys.stdout.write(f"\r  {t.get('title')} {t.get('current')}/{t.get('total')} {t.get('message','')[:60]}   ")
            sys.stdout.flush()
            time.sleep(10)
        else:
            idle += 1
            time.sleep(4)
    print()


def select_model():
    if MODEL:
        send({'type': 'selectModel', 'ref': MODEL})
        time.sleep(1.5)


def chat_generate(payload, verdict='proceed'):
    """对话页的一次单步生成：发出去、等卡片、点写入。返回是否写入了。"""
    send({'type': 'switchTab', 'tab': 'chat'})
    send({'type': 'send', 'payload': {'text': '', 'attachments': [], 'excludedIds': [], **payload}})
    if not wait_pending():
        say('没等到写入卡片（生成失败？看 log.txt）')
        return False
    answer_all(verdict)
    time.sleep(4)
    return True


# ---- 子命令 ----

def cmd_status(a):
    ws = load('last-workspaces.json') or {}
    st = (load('last-settings.json') or {}).get('settings')
    if not st:
        # 服务只在切到设置页时推 settings；没推过就直接读全局配置（不碰 secrets.json）。
        try:
            st = json.load(open(os.path.expanduser('~/.novelforge/config.json'), encoding='utf8'))
        except Exception:
            st = {}
    nxt = (load('last-pipeline.json') or {}).get('next')
    print('工程    ', ws.get('currentId'))
    print('默认模型', st.get('model'), '| 模型池', st.get('models'), '| 分档', st.get('tierModels'))
    print('下一步  ', nxt and nxt.get('label'))
    print('长任务  ', [(t['title'], t.get('message')) for t in load('tasks.json', [])])
    print('未决    ', [(p['type'], p.get('title')) for p in load('pending.json', [])])
    if ws.get('currentId'):
        cfg = book_config()
        fs = chapter_files()
        sm = nf('summaries')
        print('全书    ', cfg, '大纲覆盖到第', outline_coverage(), '章')
        print('细纲    ', len(os.listdir(nf('plots'))) if os.path.isdir(nf('plots')) else 0, '份')
        print('正文    ', len(fs), '章；未定稿', [f for f in fs if not os.path.exists(os.path.join(sm, f))][:20])


def cmd_send(a):
    send(json.loads(a.json))


def cmd_answer(a):
    print('answered', answer_all(a.verdict))


def cmd_next(a):
    s = (load('last-pipeline.json') or {}).get('next')
    if not s:
        sys.exit('没有下一步')
    if s.get('form') == 'idea':
        sys.exit('下一步是「从一句话生成小说配置」：用 idea 子命令')
    if s.get('projectAction'):
        send({'type': 'projectAction', 'action': s['projectAction'], 'relPath': (s.get('target') or {}).get('plotRelPath')})
    else:
        send({'type': 'send', 'payload': {'text': '', 'stage': s['stage'], 'capability': s['capability'], 'target': s.get('target'),
              'targetNo': s.get('no') or (s.get('range') or {}).get('from') or 1, 'range': s.get('range'),
              'writeMode': s.get('writeMode'), 'attachments': [], 'excludedIds': []}})
    say('pressed:', s['label'])


def cmd_idea(a):
    select_model()
    ok = chat_generate({'text': a.text, 'stage': 'setting', 'capability': 'generate',
                        'target': {'kind': 'setting', 'doc': 'config'}, 'targetNo': 1,
                        'setup': {'totalChapters': a.chapters, 'wordsPerChapter': a.words}})
    say('小说配置', '已写入' if ok else '未写入')


def cmd_settings(a):
    select_model()
    send({'type': 'switchTab', 'tab': 'project'})
    send({'type': 'projectAction', 'action': 'completeSettings'})
    time.sleep(5)
    wait_tasks()
    say('补齐设定完成；角色卡：', os.listdir(nf('characters')))


def cmd_outline(a):
    select_model()
    total = book_config().get('totalChapters') or sys.exit('config.md 里没有 totalChapters')
    while True:
        cov = outline_coverage()
        if cov >= total:
            say('情节大纲已覆盖到第', cov, '章')
            return
        lo, hi = cov + 1, min(cov + a.batch, total)
        say('生成情节大纲', lo, '-', hi)
        if not chat_generate({'stage': 'outline', 'capability': 'generate', 'target': {'kind': 'outline'},
                              'targetNo': lo, 'range': {'from': lo, 'to': hi}}):
            sys.exit('大纲这一段没写进去，停下')
        if outline_coverage() <= cov:
            sys.exit(f'写入之后覆盖没往前走（还是第 {cov} 章），停下看 outline.md')


def cmd_plots(a):
    select_model()
    total = a.to or book_config().get('totalChapters') or outline_coverage()
    send({'type': 'switchTab', 'tab': 'project'})
    send({'type': 'projectAction', 'action': 'generatePlots', 'range': {'from': a.from_, 'to': total}, 'confirmed': True})
    time.sleep(5)
    wait_tasks()
    say('细纲', len(os.listdir(nf('plots'))), '份')


def cmd_write(a):
    """批量写章的外层循环。批量一次最多 10 章，并且会在三种情况下停：人物提前登场、没写够八成、重演。
    停下的那一章已经落盘但没定稿——这里先补（字数不够就「接着写」一次），再定稿，再起下一批。"""
    select_model()
    cfg = book_config()
    total = a.to or cfg.get('totalChapters') or sys.exit('config.md 里没有 totalChapters')
    floor = int((cfg.get('wordsPerChapter') or 3000) * 0.8)
    tried = set()
    send({'type': 'switchTab', 'tab': 'project'})
    while True:
        answer_all()
        if load('tasks.json', []):
            wait_tasks()
            continue
        sm = nf('summaries')
        unfin = [f for f in chapter_files() if not os.path.exists(os.path.join(sm, f))]
        if unfin:
            f = unfin[0]
            wc = char_count(os.path.join(chapters_dir(), f))
            if wc < floor and f not in tried:
                tried.add(f)
                plot = next((p for p in os.listdir(nf('plots')) if p[:3] == f[:3]), None)
                say('接着写', f, wc, '字')
                if plot:
                    send({'type': 'chapterAction', 'plotRelPath': f'.novelforge/plots/{plot}', 'action': 'continue'})
                    if wait_pending():
                        answer_all()
                        time.sleep(4)
                send({'type': 'switchTab', 'tab': 'project'})
                continue
            say('定稿', f, wc, '字')
            send({'type': 'projectAction', 'action': 'finalizeChapter', 'relPath': os.path.relpath(os.path.join(chapters_dir(), f), project_root()).replace('\\', '/')})
            time.sleep(8)
            wait_tasks()
            if not os.path.exists(os.path.join(sm, f)):
                time.sleep(15)
                if not os.path.exists(os.path.join(sm, f)):
                    sys.exit(f'{f} 定稿没成，停下看 log.txt')
            continue
        n = next_chapter_no()
        if n > total:
            say('全部', total, '章已写完并定稿')
            return
        hi = min(n + 9, total)
        say('批量写章', n, '-', hi)
        send({'type': 'projectAction', 'action': 'writeManuscripts', 'range': {'from': n, 'to': hi},
              'confirmed': True, 'mode': 'finalize', 'review': bool(a.review)})
        time.sleep(10)
        wait_tasks()
        if next_chapter_no() == n and not [f for f in chapter_files() if not os.path.exists(os.path.join(sm, f))]:
            sys.exit(f'第 {n} 章这一批什么都没写出来，停下看 log.txt')


def cmd_wait(a):
    wait_tasks()


def main():
    global STATE, MODEL
    ap = argparse.ArgumentParser()
    ap.add_argument('--state', default=os.environ.get('NF_STATE', os.path.join(os.getcwd(), 'nf-state')))
    ap.add_argument('--model', default=os.environ.get('NF_MODEL'), help='每个阶段开始前 selectModel 一次')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('status')
    s = sub.add_parser('send'); s.add_argument('json')
    s = sub.add_parser('answer'); s.add_argument('verdict', nargs='?', default='proceed', choices=['proceed', 'skip'])
    sub.add_parser('next')
    s = sub.add_parser('idea'); s.add_argument('text'); s.add_argument('--chapters', type=int, default=100); s.add_argument('--words', type=int, default=3000)
    sub.add_parser('settings')
    s = sub.add_parser('outline'); s.add_argument('--batch', type=int, default=20)
    s = sub.add_parser('plots'); s.add_argument('--from', dest='from_', type=int, default=1); s.add_argument('--to', type=int)
    s = sub.add_parser('write'); s.add_argument('--to', type=int); s.add_argument('--review', action='store_true')
    sub.add_parser('wait')
    a = ap.parse_args()
    STATE = os.path.abspath(a.state)
    MODEL = a.model
    if not os.path.exists(P('pending.json')):
        sys.exit(f'{STATE} 里没有 drv.mjs 的状态：先在后台跑 node drv.mjs --state {STATE}')
    globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
    main()

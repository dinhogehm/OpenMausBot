import type { CodingTool } from "./coding-types";

export const CODING_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const CODING_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const CODING_OUTPUT_BYTES = 32_768;
export const CODING_PYTHON = "/usr/bin/python3";
// `user` in the native container API retains capabilities. Drop them in-kernel
// before the interpreter touches repository-controlled paths or launches code.
export const CODING_UNTRUSTED_PREFIX = ["/usr/bin/setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"];

export function validateCodingTool(value: unknown): asserts value is CodingTool {
  const tool = value as CodingTool | undefined;
  const text = (s: unknown, max: number) => typeof s === "string" && s.isWellFormed() && !s.includes("\0") && new TextEncoder().encode(s).length <= max;
  const path = (s: unknown) => text(s, 1024) && (s as string).length > 0 && !(s as string).startsWith("/") && !(s as string).split(/[\\/]/).some(p => p === ".." || p.toLowerCase() === ".git");
  if (!tool || typeof tool !== "object") throw new Error("invalid_coding_tool");
  if (tool.kind === "list_files" && path(tool.path)) return;
  if (tool.kind === "read_file" && path(tool.path) && Number.isSafeInteger(tool.offset) && tool.offset >= 0 && Number.isSafeInteger(tool.limit) && tool.limit > 0 && tool.limit <= CODING_OUTPUT_BYTES) return;
  if (tool.kind === "write_file" && path(tool.path) && (tool.content === null || text(tool.content, 1_048_576))) return;
  if (tool.kind === "run_command" && text(tool.command, 16_384) && tool.command.trim() && path(tool.cwd) && Number.isSafeInteger(tool.timeoutMs) && tool.timeoutMs > 0 && tool.timeoutMs <= 600_000) return;
  throw new Error("invalid_coding_tool");
}

/** Drain both native output streams, retaining only the bounded prefix. */
export async function boundedStream(stream: ReadableStream<Uint8Array> | null | undefined, limit = CODING_OUTPUT_BYTES): Promise<{ output: string; truncated: boolean }> {
  if (!stream) return { output: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, limit - retained);
      if (count) { chunks.push(value.slice(0, count)); retained += count; }
      if (count < value.length) truncated = true;
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(retained);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  // streaming decode discards an incomplete final codepoint when truncating.
  return { output: new TextDecoder().decode(bytes, { stream: truncated }), truncated };
}

export function limitedArchive(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let bytes = 0;
  return stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > CODING_ARCHIVE_BYTES) throw new Error("repository_archive_limit");
    controller.enqueue(chunk);
  } }));
}

// Fixed trusted programs are passed as argv, while all model/repository data is stdin.
// The VM is the tenant boundary. Repository processes additionally have no root
// privileges, capabilities, or access to mutable trusted verification programs.
export const CODING_INIT_PROGRAM = String.raw`
import sys, os, tarfile, pathlib, subprocess, json
root = pathlib.Path('/workspace/repo')
meta = pathlib.Path('/workspace/.veltram')
root.mkdir(parents=True, exist_ok=False)
meta.mkdir(parents=True, exist_ok=True)
def protect_checkout():
    # The sticky checkout root permits source creation but prevents UID1000 from
    # unlinking/renaming root-owned .git. Its parent and metadata are root-owned.
    root.parent.chmod(0o755)
    meta.chmod(0o700)
    for directory, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name != '.git']
        for name in dirs + files:
            os.chown(pathlib.Path(directory) / name, 1000, 1000)
    root.chmod(0o1777)
    home = pathlib.Path('/tmp/veltram-home')
    home.mkdir(exist_ok=True)
    home.chmod(0o700)
    os.chown(home, 1000, 1000)
seen = set()
prefix = None
size = 0
count = 0
try:
    archive = tarfile.open(fileobj=sys.stdin.buffer, mode='r|gz')
    for item in archive:
        count += 1
        if count > 20000: raise ValueError('repository_file_limit')
        parts = pathlib.PurePosixPath(item.name).parts
        if not parts or item.name.startswith('/') or '..' in parts or any(p.lower() == '.git' for p in parts): raise ValueError('unsafe_archive_path')
        if prefix is None: prefix = parts[0]
        if parts[0] != prefix: raise ValueError('unsafe_archive_root')
        if len(parts) == 1:
            if not item.isdir(): raise ValueError('unsafe_archive_root')
            continue
        relative = pathlib.PurePosixPath(*parts[1:])
        if len(str(relative).encode()) > 1024: raise ValueError('repository_path_limit')
        target = root.joinpath(*relative.parts)
        if item.isdir(): target.mkdir(parents=True, exist_ok=True); continue
        if not item.isfile() or str(relative) == '.gitmodules': raise ValueError('unsupported_repository_entry')
        if str(relative) in seen: raise ValueError('duplicate_archive_path')
        seen.add(str(relative))
        size += item.size
        if item.size > 64 * 1024 * 1024 or size > 512 * 1024 * 1024: raise ValueError('repository_size_limit')
        target.parent.mkdir(parents=True, exist_ok=True)
        source = archive.extractfile(item)
        if source is None: raise ValueError('invalid_archive')
        with target.open('xb') as output:
            remaining = item.size
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk: raise ValueError('invalid_archive')
                output.write(chunk); remaining -= len(chunk)
        target.chmod(0o755 if item.mode & 0o111 else 0o644)
    if not seen: raise ValueError('empty_repository')
    env = {'PATH': os.environ['PATH'], 'HOME': '/tmp/veltram-home', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
    def git(*args):
        return subprocess.check_output(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', *args], cwd=root, env=env)
    git('init', '-q')
    git('add', '-A', '-f', '--', '.')
    git('-c', 'user.name=Veltram', '-c', 'user.email=agent@veltram.invalid', 'commit', '-q', '-m', 'Repository snapshot')
    baseline = git('rev-parse', 'HEAD').decode().strip()
    (meta / 'baseline.json').write_text(json.dumps({'baseline': baseline, 'sourceSha': sys.argv[1]}))
    protect_checkout()
    print(json.dumps({'baseline': baseline}))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;

export const CODING_TOOL_PROGRAM = String.raw`
import sys, os, pathlib, subprocess, json, hashlib, stat, re, difflib, time, signal
root = pathlib.Path('/workspace/repo')
meta = pathlib.Path('/workspace/.veltram')
def safe_path(value):
    if not isinstance(value, str) or not value or '\x00' in value or '\\' in value: raise ValueError('invalid_path')
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or any(p.lower() == '.git' for p in path.parts): raise ValueError('invalid_path')
    candidate = root.joinpath(*path.parts)
    if not candidate.resolve().is_relative_to(root.resolve()): raise ValueError('path_outside_repository')
    cursor = candidate
    while cursor != root:
        if cursor.is_symlink(): raise ValueError('unsupported_symlink')
        cursor = cursor.parent
    return candidate
def git(*args):
    return subprocess.check_output(['/usr/bin/git', '-c', 'safe.directory=' + str(root), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', *args], cwd=root, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'HOME': '/tmp/veltram-home'})
def paths(data): return [p.decode('utf-8', 'strict') for p in data.split(b'\0') if p]
def quiesce_repository():
    # A shell may leave descendants with redirected output. UID1000 has no
    # capabilities and cannot change identity; stop every live descendant before
    # trusting a filesystem observation. Zombies cannot mutate the checkout.
    deadline = time.monotonic() + 5
    while True:
        active = []
        for entry in pathlib.Path('/proc').iterdir():
            if not entry.name.isdigit(): continue
            try:
                status = dict(line.split(':', 1) for line in (entry / 'status').read_text().splitlines() if ':' in line)
                if 1000 in [int(uid) for uid in status.get('Uid', '').split()] and not status.get('State', '').strip().startswith('Z'):
                    active.append(int(entry.name))
            except (FileNotFoundError, ProcessLookupError): pass
        if not active: return
        if time.monotonic() >= deadline: raise ValueError('repository_processes_not_quiescent')
        for pid in active:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        time.sleep(0.02)
def manifest(baseline):
    quiesce_repository()
    if not re.fullmatch('[a-f0-9]{40}', baseline): raise ValueError('invalid_baseline')
    original = {}
    for entry in git('ls-tree', '-r', '-z', '--full-tree', baseline).split(b'\0'):
        if not entry: continue
        metadata, name = entry.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split(' ')
        if kind != 'blob' or mode not in ['100644', '100755']: raise ValueError('unsupported_repository_entry')
        original[name.decode('utf-8', 'strict')] = (mode, oid)
    names = sorted(set(original) | set(paths(git('ls-files', '-z', '--cached', '--others', '--exclude-standard'))))
    if len(names) > 20000: raise ValueError('repository_file_limit')
    changes = []
    total = 0
    scanned = 0
    for name in names:
        path = safe_path(name)
        previous = original.get(name)
        if not path.exists():
            if previous: changes.append({'path': name, 'content': None, 'mode': previous[0]})
            continue
        if not path.is_file() or path.is_symlink(): raise ValueError('unsupported_change_entry')
        size = path.stat().st_size
        scanned += size
        if size > 64 * 1024 * 1024 or scanned > 512 * 1024 * 1024: raise ValueError('repository_size_limit')
        data = path.read_bytes()
        mode = '100755' if path.stat().st_mode & stat.S_IXUSR else '100644'
        oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if previous == (mode, oid): continue
        if len(data) > 1048576: raise ValueError('change_file_size_limit')
        total += len(data)
        if total > 10485760: raise ValueError('change_size_limit')
        content = data.decode('utf-8', 'strict')
        if '\x00' in content: raise ValueError('binary_change_unsupported')
        changes.append({'path': name, 'content': content, 'mode': mode})
    if len(changes) > 100: raise ValueError('change_file_limit')
    for change in changes:
        if change['path'].lower().startswith('.github/workflows/') or change['path'].lower() == '.gitmodules': raise ValueError('unsupported_workflow_or_submodule_change')
    return changes, original
try:
    tool = json.load(sys.stdin)
    kind = tool['kind']
    if kind == 'run_command':
        cwd = safe_path(tool['cwd'])
        if not cwd.is_dir(): raise ValueError('invalid_directory')
        os.chdir(cwd)
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp/veltram-home', 'CI': 'true', 'PYTHONDONTWRITEBYTECODE': '1', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': str(root), 'PIP_DISABLE_PIP_VERSION_CHECK': '1'}
        ca = '/etc/cloudflare/certs/cloudflare-containers-ca.crt'
        if os.path.isfile(ca):
            env['NODE_EXTRA_CA_CERTS'] = ca
            env['REQUESTS_CA_BUNDLE'] = '/etc/ssl/certs/ca-certificates.crt'
            env['SSL_CERT_FILE'] = '/etc/ssl/certs/ca-certificates.crt'
        os.execvpe('/bin/bash', ['bash', '--noprofile', '--norc', '-c', tool['command']], env)
    elif kind == 'list_files':
        directory = safe_path(tool['path'])
        if not directory.is_dir(): raise ValueError('invalid_directory')
        names = sorted(set(paths(git('ls-files', '-z', '--cached', '--others', '--exclude-standard'))))
        for name in names:
            path = safe_path(name)
            if path.is_relative_to(directory): print(name)
    elif kind == 'read_file':
        path = safe_path(tool['path'])
        if not path.is_file(): raise ValueError('file_not_found')
        with path.open('rb') as handle:
            handle.seek(tool['offset'])
            data = handle.read(tool['limit'])
        sys.stdout.write(data.decode('utf-8', 'replace'))
    elif kind == 'write_file':
        path = safe_path(tool['path'])
        if tool['content'] is None:
            if not path.is_file(): raise ValueError('file_not_found')
            path.unlink()
        else:
            data = tool['content'].encode('utf-8')
            if len(data) > 1048576: raise ValueError('file_size_limit')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        print('File updated')
    elif kind == 'review_diff':
        baseline = tool.get('baseline', '')
        changes, original = manifest(baseline)
        for change in changes:
            name = change['path']
            previous = original.get(name)
            old = git('cat-file', 'blob', previous[1]).decode('utf-8', 'strict') if previous else ''
            new = change['content'] or ''
            print('diff --git ' + json.dumps('a/' + name) + ' ' + json.dumps('b/' + name))
            print('mode ' + (previous[0] if previous else 'absent') + ' -> ' + (change['mode'] if change['content'] is not None else 'deleted'))
            sys.stdout.writelines(difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True), fromfile='a/' + name, tofile='b/' + name))
    elif kind == 'snapshot':
        baseline = tool.get('baseline', '')
        changes, original = manifest(baseline)
        digest = hashlib.sha256(json.dumps(changes, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        print(json.dumps({'files': changes, 'treeDigest': digest.hexdigest()}, ensure_ascii=False))
    else: raise ValueError('invalid_tool')
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;

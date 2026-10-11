import base64
import datetime
import hashlib
import json
import os
import stat
import sys


def read_target(value):
    if isinstance(value, str):
        value = value.replace('\\', '/')
        if value.startswith('/') or ':' in value or '..' in value.split('/'):
            raise PermissionError('Path must stay inside the workspace')
        value = '/'.join(part for part in value.split('/') if part not in ('', '.')) or '.'
    if value == '.':
        return os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY)
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise ValueError('Path must be a non-empty relative path')
    if '\\' in value or value.startswith('/') or ':' in value:
        raise PermissionError('Path must stay inside the workspace')
    parts = value.split('/')
    if any(part in ('', '.', '..') or part.lower() in ('.agent-data', '.git', 'node_modules', '.env') or part.lower().startswith('.env.') for part in parts):
        raise PermissionError('Path escapes or accesses private agent data')
    fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC | (os.O_DIRECTORY if index < len(parts) - 1 else 0)
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def entries(directory):
    fd = read_target(directory)
    try:
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise ValueError('Path is not a directory')
        with os.scandir(fd) as iterator:
            items = sorted(iterator, key=lambda item: item.name)
        if len(items) > 20_000:
            raise ValueError('Directory has too many entries')
        return [(item.name, item.is_dir(follow_symlinks=False), item.is_file(follow_symlinks=False),
                 item.is_symlink()) for item in items]
    finally:
        os.close(fd)


def visible(name):
    lower = name.lower()
    return lower not in ('.agent-data', '.git', '.env', 'node_modules') and not lower.startswith('.env.')


def list_files(args):
    directory = args.get('path', '.')
    listing = entries(directory)
    stamp = hashlib.sha256('\n'.join(f'{name}:{is_dir}:{linked}' for name, is_dir, _, linked in listing).encode()).hexdigest()
    if args.get('stamp') is not None and args['stamp'] != stamp:
        raise ValueError('Directory changed since previous page; start again')
    offset, limit = args.get('offset', 0), args.get('limit', 100)
    result = []
    while offset < len(listing) and len(result) < limit:
        name, is_dir, is_file, linked = listing[offset]
        offset += 1
        if visible(name) and not linked and (is_dir or is_file):
            result.append(dict(path=name if directory == '.' else f'{directory}/{name}',
                               type='directory' if is_dir else 'file'))
    while offset < len(listing) and (not visible(listing[offset][0]) or listing[offset][3]):
        offset += 1
    return dict(items=result, nextOffset=offset if offset < len(listing) else None, stamp=stamp)


def scan_items(kind, query, directory):
    pending = [directory]
    while pending:
        current = pending.pop(0)
        for name, is_dir, is_file, linked in entries(current):
            if not visible(name) or linked:
                continue
            if not is_dir and not is_file:
                continue
            relative = name if current == '.' else f'{current}/{name}'
            yield None
            if is_dir:
                pending.append(relative)
            if kind == 'find_files' and query in name.lower():
                yield dict(path=relative, type='directory' if is_dir else 'file')
            if kind == 'search_text' and is_file:
                fd = read_target(relative)
                try:
                    details = os.fstat(fd)
                    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size > 100_000:
                        continue
                    data = os.read(fd, 100_001)
                finally:
                    os.close(fd)
                if len(data) > 100_000 or b'\0' in data:
                    continue
                try:
                    text = data.decode('utf-8')
                except UnicodeError:
                    continue
                for index, line in enumerate(text.replace('\r\n', '\n').split('\n'), 1):
                    if query in line.lower():
                        yield dict(path=relative, line=index, text=line[:300])


def scan(args, kind):
    directory, query = args.get('path', '.'), args['query'].lower()
    if not query.strip() or len(query) > 200:
        raise ValueError('Query must be 1-200 characters')
    offset, limit = args.get('offset', 0), args.get('limit', 50)
    stream = scan_items(kind, query, directory)
    results = []
    scanned = 0
    position = 0
    for value in stream:
        position += 1
        if position <= offset:
            continue
        if value is None:
            scanned += 1
        else:
            results.append(value)
        if len(results) >= limit or scanned >= 2000:
            break
    else:
        return dict(items=results, nextOffset=None) if kind == 'find_files' else dict(matches=results, nextOffset=None)
    sentinel = object()
    next_offset = position if next(stream, sentinel) is not sentinel else None
    return dict(items=results, nextOffset=next_offset) if kind == 'find_files' else dict(matches=results, nextOffset=next_offset)


def main():
    request = json.loads(base64.urlsafe_b64decode(sys.argv[1] + '==='))
    name, args = request['name'], request['args']
    if name in ('list_files', 'find_files', 'search_text'):
        if name == 'list_files':
            return list_files(args)
        return scan(args, name)
    fd = read_target(args['path'])
    try:
        details = os.fstat(fd)
        if stat.S_ISREG(details.st_mode) and details.st_nlink != 1:
            raise PermissionError('Hard-linked files are not available')
        if name == 'file_info':
            if not (stat.S_ISREG(details.st_mode) or stat.S_ISDIR(details.st_mode)):
                raise ValueError('Path is not a regular file or directory')
            total = None
            if stat.S_ISREG(details.st_mode) and details.st_size <= 2_000_000:
                data = os.read(fd, 2_000_001)
                if len(data) <= 2_000_000 and b'\0' not in data:
                    try:
                        total = len(data.decode('utf-8').replace('\r\n', '\n').split('\n'))
                    except UnicodeError:
                        pass
            return dict(path=args['path'], type='file' if stat.S_ISREG(details.st_mode) else 'directory',
                        sizeBytes=details.st_size, modifiedAt=datetime.datetime.fromtimestamp(
                            details.st_mtime, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), totalLines=total)
        if name != 'read_file' or not stat.S_ISREG(details.st_mode):
            raise ValueError('Path is not a regular file')
        ranged = 'startLine' in args or 'lineCount' in args
        if ranged and details.st_size > 2_000_000:
            raise ValueError('File is not a regular text file under 2 MB')
        if not ranged and details.st_size > 160_000:
            raise ValueError('File exceeds 40,000 characters')
        data = os.read(fd, 2_000_001 if ranged else 160_001)
        if ranged and (len(data) > 2_000_000 or b'\0' in data):
            raise ValueError('File exceeds 2 MB or is binary')
        text = data.decode('utf-8', errors='strict' if ranged else 'replace')
        if not ranged:
            if len(text.encode('utf-16-le')) // 2 > 40_000:
                raise ValueError('File exceeds 40,000 characters')
            return text
        lines = text.replace('\r\n', '\n').split('\n')
        start, count = args.get('startLine', 1), args.get('lineCount', 100)
        if not isinstance(start, int) or not isinstance(count, int) or start < 1 or not 1 <= count <= 200:
            raise ValueError('Invalid line range')
        selected = lines[start - 1:start - 1 + count]
        if len('\n'.join(selected).encode('utf-16-le')) // 2 > 40_000:
            raise ValueError('Selected lines exceed 40,000 characters; request fewer lines')
        return dict(path=args['path'], startLine=start, totalLines=len(lines),
                    lines=[dict(line=start + i, text=line) for i, line in enumerate(selected)],
                    hasMore=start - 1 + len(selected) < len(lines))
    finally:
        os.close(fd)


try:
    print(json.dumps(dict(ok=True, value=main()), ensure_ascii=False))
except Exception as error:
    code = 'WORKSPACE_ACCESS_DENIED' if isinstance(error, PermissionError) or isinstance(error, OSError) and error.errno in (40,) else 'TOOL_EXECUTION_ERROR'
    print(json.dumps(dict(ok=False, code=code, message=str(error)), ensure_ascii=False))

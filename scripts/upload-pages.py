#!/usr/bin/env python3
"""
upload-pages.py — Cloudflare Pages 部署包直传（manifest 模式）

Pages 直传 API 要求：manifest（文件哈希 → 项目相对路径）+ 每个文件一个表单字段（字段名=哈希）。
本脚本遍历部署包目录，计算 SHA-256 并组装 multipart 请求上传。

用法：python3 scripts/upload-pages.py <账户ID> <API令牌> <Pages项目名> <部署包目录>
"""
import sys
import os
import json
import hashlib
import uuid
import urllib.request


def build_multipart(fields, files):
    """构造 multipart/form-data 请求体。files: [(field, path, filename)]"""
    boundary = '----vpngate' + uuid.uuid4().hex
    body = b''
    for key, value in fields.items():
        body += (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n'
            f'{value}\r\n'
        ).encode('utf-8')
    for key, path, filename in files:
        with open(path, 'rb') as f:
            data = f.read()
        body += (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="{key}"; filename="{filename}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n'
        ).encode('utf-8') + data + b'\r\n'
    body += f'--{boundary}--\r\n'.encode('utf-8')
    return boundary, body


def main():
    if len(sys.argv) != 5:
        print('用法：python3 scripts/upload-pages.py <账户ID> <API令牌> <Pages项目名> <部署包目录>')
        sys.exit(1)
    account, token, project, root = sys.argv[1:5]
    if not os.path.isdir(root):
        print(f'部署包目录不存在：{root}')
        sys.exit(1)

    # 收集文件并计算哈希
    files = []
    manifest = {}
    for dirpath, _, names in os.walk(root):
        for name in names:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            with open(full, 'rb') as f:
                digest = hashlib.sha256(f.read()).hexdigest()
            manifest[digest] = rel
            files.append((digest, full, name))

    if not files:
        print('部署包目录为空')
        sys.exit(1)

    boundary, body = build_multipart({'manifest': json.dumps(manifest)}, files)
    url = (
        f'https://api.cloudflare.com/client/v4/accounts/{account}'
        f'/pages/projects/{project}/deployments'
    )
    req = urllib.request.Request(
        url, data=body, method='POST',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': f'multipart/form-data; boundary={boundary}',
        },
    )
    print(f'上传 {len(files)} 个文件到 Pages 项目 {project} …')
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.loads(resp.read().decode('utf-8'))

    if not data.get('success'):
        print('上传失败：', json.dumps(data.get('errors'), ensure_ascii=False))
        sys.exit(1)
    result = data.get('result') or {}
    print('上传成功')
    print('deployment_id:', result.get('id'))
    print('url:', result.get('url'))
    return result


if __name__ == '__main__':
    main()

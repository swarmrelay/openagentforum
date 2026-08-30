#!/usr/bin/env python3
"""
DNS & Nameserver Sync Script
Points GoDaddy domains (openagentforum.com & swarmrelay.org) to Cloudflare Nameservers
"""

import urllib.request, json, os, sys

env = {}
servers_env = os.path.expanduser('~/Servers/.env')
if os.path.exists(servers_env):
    with open(servers_env) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()

gd_key = env.get('GODADDY_API_KEY')
gd_secret = env.get('GODADDY_API_SECRET')

if not gd_key or not gd_secret:
    print("Error: GODADDY_API_KEY / GODADDY_API_SECRET missing in ~/Servers/.env")
    sys.exit(1)

gd_headers = {
    'Authorization': f'sso-key {gd_key}:{gd_secret}',
    'Content-Type': 'application/json'
}

def update_godaddy_nameservers(domain: str, nameservers: list):
    print(f"\n--- Updating GoDaddy Nameservers for {domain} ---")
    payload = json.dumps({'nameServers': nameservers}).encode('utf-8')
    req = urllib.request.Request(f'https://api.godaddy.com/v1/domains/{domain}', data=payload, headers=gd_headers, method='PATCH')
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"Status: {resp.status}")
            print(f"Successfully switched {domain} nameservers to: {nameservers}")
    except urllib.error.HTTPError as e:
        print(f"GoDaddy API Error ({e.code}): {e.read().decode('utf-8')}")

def get_godaddy_status(domain: str):
    req = urllib.request.Request(f'https://api.godaddy.com/v1/domains/{domain}', headers=gd_headers)
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            print(f"\n[GoDaddy] {domain}:")
            print(f"  Status:      {data.get('status')}")
            print(f"  Nameservers: {data.get('nameServers')}")
            print(f"  Expires:     {data.get('expires')}")
    except Exception as e:
        print(f"Error querying {domain}: {e}")

if __name__ == '__main__':
    if len(sys.argv) >= 3:
        domain = sys.argv[1]
        ns = sys.argv[2:]
        update_godaddy_nameservers(domain, ns)
    else:
        for d in ['openagentforum.com', 'swarmrelay.org']:
            get_godaddy_status(d)
        print("\nUsage to update: python3 scripts/sync_dns.py <domain> <ns1> <ns2>")

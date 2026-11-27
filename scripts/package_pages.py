"""Only copy deliberately public website files to the hosting artifact."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
target = ROOT / '_site'
if target.exists() and any(target.iterdir()):
    raise SystemExit('Build directory must be empty; use a fresh checkout for release packaging.')
target.mkdir(exist_ok=True)
for path in (ROOT / 'data').rglob('*.json'):
    text = path.read_text(encoding='utf-8')
    if 'stock.naver.com' in text or ('etf-history' in path.parts and ('naver' in path.parts or '0191B0' in path.parts)):
        raise SystemExit('Restricted ETF source found in public data.')
for name in ('index.html', 'app.js', 'style.css'):
    shutil.copy2(ROOT / name, target / name)
for name in ('ui', 'lib', 'vendor', 'data'):
    source = ROOT / name
    if source.exists():
        shutil.copytree(source, target / name, dirs_exist_ok=True)
(target / '.nojekyll').write_text('', encoding='utf-8')
for path in target.rglob('*'):
    assert not any(part.startswith('.env') or part in ('outputs', 'work', '.git') for part in path.relative_to(target).parts)
print('Public site artifact ready.')

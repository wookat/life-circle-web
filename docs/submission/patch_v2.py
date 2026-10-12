# -*- coding: utf-8 -*-
import io, fitz

SRC = 'docs/submission/圈点-参赛作品介绍.pdf'
REG = 'C:/Windows/Fonts/msyh.ttc'
BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
NEW_HASH = '66518bc'

def rgb(ci):
    return ((ci>>16&255)/255, (ci>>8&255)/255, (ci&255)/255)

def find_span(page, needle):
    for b in page.get_text('dict')['blocks']:
        if b.get('type') != 0: continue
        for l in b['lines']:
            for sp in l['spans']:
                if needle in sp['text']:
                    return sp
    return None

def find_line(page, needle):
    for b in page.get_text('dict')['blocks']:
        if b.get('type') != 0: continue
        for l in b['lines']:
            full = ''.join(sp['text'] for sp in l['spans'])
            if needle in full:
                return l
    return None

doc = fitz.open(SRC)

# ===== 五图替换 =====
doc[2].replace_image(6, filename='docs/data/screenshots/A-adult.png')
doc[6].replace_image(12, filename='docs/data/screenshots/A-elderly.png')
doc[7].replace_image(14, filename='docs/data/screenshots/B-urban.png')
doc[8].replace_image(16, filename='docs/data/screenshots/street-batch.png')
doc[9].replace_image(18, filename='docs/data/screenshots/district-pilot.png')

# ===== 文本修订（span 级：定位唯一文本 → 原位重写） =====
span_jobs = [
    (7, '68 / C', '77 / B'),
    (7, '34%', '无法评估'),
    (7, '34 处', '43 处'),
    (8, '88.4 分', '86.5 分'),
    (8, '14 分', '15 分'),
    (0, '2026-10-10', '2026-10-12'),
]
for pno, needle, new in span_jobs:
    page = doc[pno]
    sp = find_span(page, needle)
    if sp is None:
        print(f'WARN span not found p{pno+1}: {needle}')
        continue
    rect = fitz.Rect(sp['bbox']) + (-0.5, -0.5, 0.5, 0.5)
    origin = sp['origin']
    size = sp['size']
    color = rgb(sp['color'])
    page.add_redact_annot(rect)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    page.insert_text(fitz.Point(*origin), new, fontsize=size, fontname='china-s', fontfile=REG, color=color)

# ===== 行级修订 =====
line_jobs = [
    (8, '截图中有 2 个薄弱样本', '截图中有 2 个薄弱样本（三清山东大道辅路 78 分 / 覆盖率 71%，青阳路 83 分 / 覆盖率 79%），主要短板为菜市场。产品把"均值较高"与"仍有薄弱区', REG),
    (9, '历史城区试点截图', 'v2 城区试点截图（2026-10-12 晨批次）：14 个社区，整体均值 77.1 分，最高最低差距 28 分。', REG),
]
for pno, needle, new, font in line_jobs:
    page = doc[pno]
    line = find_line(page, needle)
    if line is None:
        print(f'WARN line not found p{pno+1}: {needle[:30]}')
        continue
    rect = fitz.Rect(line['bbox']) + (-1, -1, 1, 1)
    s0 = line['spans'][0]
    origin = s0['origin']
    size = s0['size']
    color = rgb(s0['color'])
    page.add_redact_annot(rect)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    page.insert_text(fitz.Point(*origin), new, fontsize=size, fontname='china-s', fontfile=font, color=color)

# ===== 版本号替换：4f981b2 → 66518bc（全页扫描） =====
for pno in range(len(doc)):
    page = doc[pno]
    spans = []
    for b in page.get_text('dict')['blocks']:
        if b.get('type') != 0: continue
        for l in b['lines']:
            for sp in l['spans']:
                if '4f981b2' in sp['text']:
                    spans.append(sp)
    for sp in spans:
        rect = fitz.Rect(sp['bbox']) + (-0.5, -0.5, 0.5, 0.5)
        page.add_redact_annot(rect)
    if spans:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
        for sp in spans:
            new_text = sp['text'].replace('4f981b2', NEW_HASH)
            page.insert_text(fitz.Point(*sp['origin']), new_text, fontsize=sp['size'], fontname='china-s', fontfile=REG, color=rgb(sp['color']))

doc.save(SRC + '.v2', garbage=3, deflate=True)
doc.close()
print('v2 PDF saved')

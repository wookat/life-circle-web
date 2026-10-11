import { useState } from 'react';
import { Button, Input, Select, Space } from 'antd';

const CORR_OPTIONS = ['已核验', '停业', '迁移', '分类错误'].map((v) => ({ value: v, label: v }));

export interface PoiPopProps {
  name: string;
  category: string;
  address: string;
  uid: string;
  /** 动作出口：与 controller 的 poiAction 同一契约（dataset 字段） */
  act: (ds: Record<string, string>) => void;
}

export function PoiPop({ name, category, address, uid, act }: PoiPopProps) {
  const [status, setStatus] = useState('已核验');
  const [note, setNote] = useState('');
  return (
    <div className="poi-pop">
      <div className="poi-pop-sub">{category}{address ? ` · ${address}` : ''}</div>
      <Space wrap size={6} className="poi-pop-actions">
        <Button size="small" data-route-uid={uid} onClick={() => act({ routeUid: uid })}>步行路线核验</Button>
        <Button size="small" data-hours-uid={uid} onClick={() => act({ hoursUid: uid })}>营业时段</Button>
      </Space>
      <Space wrap size={6} className="poi-pop-actions">
        <Select size="small" value={status} onChange={setStatus} options={CORR_OPTIONS} style={{ width: 96 }} />
        <Input size="small" value={note} onChange={(e) => setNote(e.target.value)} placeholder="说明(可空)" style={{ width: 104 }} />
        <Button size="small" type="primary" onClick={() => act({ corrSave: uid, corrStatus: status, corrNote: note })}>标注</Button>
        <Button size="small" onClick={() => act({ corrUndoUid: uid })}>撤销标注</Button>
      </Space>
    </div>
  );
}

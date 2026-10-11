import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App.js';
import '../style.css';

/**
 * 定制主题（深色顶栏 + 大圆角扁平卡片风）：
 * - 8px 间距网格、控件统一高度 32、圆角体系 6/10/14
 * - 卡片/面板扁平无阴影，浮层（下拉/弹窗）保留柔和投影
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  // 不开 StrictMode：dev 下 effect 双跑会让 init()/projectUi 重复绑定副作用
  <ConfigProvider
    locale={zhCN}
    theme={{
      algorithm: antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: '#2f6fed',
        colorInfo: '#2f6fed',
        colorLink: '#2f6fed',
        colorSuccess: '#2b8a3e',
        colorWarning: '#d9480f',
        colorError: '#c92a2a',
        colorText: '#1f2a37',
        colorTextSecondary: '#4b5a6b',
        colorBgLayout: '#f4f6f9',
        colorBgContainer: '#ffffff',
        colorBorder: '#dbe2ea',
        colorBorderSecondary: '#e6eaf0',
        borderRadius: 10,
        borderRadiusLG: 14,
        borderRadiusSM: 6,
        controlHeight: 32,
        fontSize: 13,
        fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
        boxShadowSecondary: '0 12px 32px rgba(15, 23, 42, 0.16)',
      },
      components: {
        Button: { borderRadius: 10, controlHeight: 32 },
        Input: { borderRadius: 10 },
        InputNumber: { borderRadius: 10 },
        Select: { borderRadius: 10 },
        Modal: { borderRadiusLG: 16 },
        Table: { headerBg: '#f7f9fc', headerColor: '#4b5a6b', cellPaddingBlock: 8 },
        Tag: { borderRadiusSM: 6 },
        Alert: { borderRadiusLG: 10 },
        Tabs: { horizontalItemGutter: 16 },
      },
    }}
  >
    <App />
  </ConfigProvider>
);

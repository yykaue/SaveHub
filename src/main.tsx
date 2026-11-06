import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { t } from './i18n';
import './styles.css';
import './list.css';

/**
 * 顶层渲染错误边界，捕获 React 树未处理异常并提供重载入口。
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="boot-screen">
          <h1>{t('app.errorBoundaryTitle')}</h1>
          <p>{this.state.error}</p>
          <button onClick={() => window.location.reload()}>{t('app.reload')}</button>
          <p>{t('app.errorBoundaryDesc')}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

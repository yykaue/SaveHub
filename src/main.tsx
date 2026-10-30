import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './list.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <div className="boot-screen"><h1>界面暂时遇到问题</h1><p>{this.state.error}</p><button onClick={() => window.location.reload()}>重新加载</button><p>已保存的存档仍在本地资料库中。</p></div>;
    return this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App/></ErrorBoundary></React.StrictMode>);

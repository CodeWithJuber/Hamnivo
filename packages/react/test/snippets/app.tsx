import { HamnivoChat } from '@hamnivo/react';

export function App() {
  return (
    <>
      {/* The rest of your app */}
      <HamnivoChat
        widgetId="wid_01j9zk7w3xq8r4t2v6m5n1p0ce"
        chatUrl="https://chat.example.com"
        apiUrl="https://api.example.com"
      />
    </>
  );
}

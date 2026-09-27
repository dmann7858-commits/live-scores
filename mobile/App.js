import React, { useRef } from "react";
import { View, Text, Linking, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { StatusBar } from "expo-status-bar";

// Where GoalFlash lives. Everything the app shows comes from here.
const APP_URL = "https://live-scores-1.onrender.com";
const APP_HOST = "live-scores-1.onrender.com";

export default function App() {
  const web = useRef(null);

  // Your own pages open inside the app. Anything else (the news
  // stories, for example) opens in Safari, so the reader can come
  // straight back to GoalFlash.
  function handleLink(request) {
    const url = request.url || "";
    if (url.startsWith("about:") || url.startsWith("data:")) return true;
    if (url.indexOf(APP_HOST) !== -1) return true;

    Linking.openURL(url);
    return false;
  }

  function offlineScreen() {
    return (
      <View style={styles.offline}>
        <Text style={styles.offlineHead}>GoalFlash can't connect</Text>
        <Text style={styles.offlineText}>
          Check your internet connection, then pull down to try again.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <StatusBar style="light" />
      <WebView
        ref={web}
        source={{ uri: APP_URL }}
        style={styles.page}
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={handleLink}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures={true}
        pullToRefreshEnabled={true}
        contentInsetAdjustmentBehavior="never"
        domStorageEnabled={true}
        javaScriptEnabled={true}
        startInLoadingState={true}
        renderError={offlineScreen}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#0B1E3D" },
  offline: {
    flex: 1, backgroundColor: "#0B1E3D",
    alignItems: "center", justifyContent: "center", padding: 30,
  },
  offlineHead: { color: "#FFFFFF", fontSize: 18, fontWeight: "600", marginBottom: 10 },
  offlineText: { color: "#8FA6C4", fontSize: 14, textAlign: "center" },
});

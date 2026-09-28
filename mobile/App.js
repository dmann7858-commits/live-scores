import React, { useRef } from "react";
import { View, Text, Linking, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { StatusBar } from "expo-status-bar";

// Where GoalFlash lives. Everything the app shows comes from here.
const APP_URL = "https://www.goalflash.app";

// Addresses that belong to GoalFlash and open inside the app.
// The old Render address stays on the list so nothing breaks while
// anyone still has it cached.
const OUR_HOSTS = [
  "goalflash.app",
  "www.goalflash.app",
  "live-scores-1.onrender.com",
];

function hostOf(url) {
  const match = String(url || "").match(/^https?:\/\/([^\/?#:]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function isOurs(url) {
  return OUR_HOSTS.indexOf(hostOf(url)) !== -1;
}

export default function App() {
  const web = useRef(null);

  // Decides where each page load goes.
  function handleLink(request) {
    const url = request.url || "";

    // Blank frames and inline content are part of the page itself.
    if (url.startsWith("about:") || url.startsWith("data:") ||
        url.startsWith("blob:")) {
      return true;
    }

    // Advert frames load from Google inside the page. They must be
    // allowed to load where they are - pushing them out to Safari
    // would break every ad and open Safari on its own.
    if (request.isTopFrame === false) return true;

    // GoalFlash's own pages stay in the app.
    if (isOurs(url)) return true;

    // Anything else the whole screen tries to go to (a news story,
    // an advert someone tapped) opens in Safari instead, so the
    // person can come straight back to GoalFlash.
    Linking.openURL(url);
    return false;
  }

  // Links that ask for a new window - news headlines and tapped
  // adverts both do this - open in Safari.
  function handleNewWindow(event) {
    const url = event.nativeEvent && event.nativeEvent.targetUrl;
    if (url) Linking.openURL(url);
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
        onOpenWindow={handleNewWindow}
        setSupportMultipleWindows={true}
        applicationNameForUserAgent="GoalFlashApp/1.0"
        allowsBackForwardNavigationGestures={true}
        pullToRefreshEnabled={true}
        contentInsetAdjustmentBehavior="never"
        domStorageEnabled={true}
        javaScriptEnabled={true}
        sharedCookiesEnabled={true}
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

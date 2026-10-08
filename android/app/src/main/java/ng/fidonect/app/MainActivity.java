package ng.fidonect.app;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Minimal wrapper: the Fidonect web app served from Render, rendered in a WebView. */
public class MainActivity extends Activity {
    private static final String HOME = "https://fidonect-api.onrender.com/";
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    view.loadData("<html><body style='font-family:sans-serif;padding:24px'>"
                            + "<h2>Fidonect needs internet</h2>"
                            + "<p>Connect to the internet and reopen the app.</p>"
                            + "<p>The free Render backend also sleeps when idle and can take about 60 seconds to wake — wait, then reopen.</p>"
                            + "</body></html>", "text/html", "UTF-8");
                }
            }
        });
        setContentView(web);
        if (savedInstanceState == null) {
            web.loadUrl(HOME);
        } else {
            web.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}

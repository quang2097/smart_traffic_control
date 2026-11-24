package com.smarttraffic.android;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URL;
import android.app.Activity;
import android.content.Intent;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
import java.io.OutputStream;

@CapacitorPlugin(name = "TrafficCamera")
public class TrafficCameraPlugin extends Plugin {
    @PluginMethod public void stopMedia(PluginCall call) {
        ((MainActivity) getActivity()).stopCameraMedia();
        call.resolve();
    }
    @PluginMethod public void setBackend(PluginCall call) {
        try {
            URL url = new URL(call.getString("base", ""));
            if ((!url.getProtocol().equals("http") && !url.getProtocol().equals("https")) || url.getHost().isEmpty()
                || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null
                || (!url.getPath().isEmpty() && !url.getPath().equals("/"))) throw new Exception("Invalid backend origin");
            String origin = url.getProtocol() + "://" + url.getHost() + (url.getPort() == -1 ? "" : ":" + url.getPort());
            ((MainActivity) getActivity()).setCameraBackend(origin);
            call.resolve();
        } catch (Exception error) { call.reject("Invalid camera backend origin"); }
    }
    @PluginMethod public void saveDemoFile(PluginCall call) {
        String name=call.getString("name", ""), data=call.getString("data", "");
        if (!(name.equals("traffic-classification.png") || name.equals("traffic-demo.json")) || data.length()>12*1024*1024) { call.reject("Invalid demo export"); return; }
        Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType(name.endsWith(".png")?"image/png":"application/json");
        intent.putExtra(Intent.EXTRA_TITLE,name);
        startActivityForResult(call,intent,"saveDemoResult");
    }
    @ActivityCallback private void saveDemoResult(PluginCall call, ActivityResult result) {
        if(call==null)return;
        if(result.getResultCode()!=Activity.RESULT_OK || result.getData()==null || result.getData().getData()==null){call.resolve();return;}
        try(OutputStream stream=getContext().getContentResolver().openOutputStream(result.getData().getData())){
            if(stream==null)throw new Exception("No export stream");
            stream.write(Base64.decode(call.getString("data", ""),Base64.DEFAULT));call.resolve();
        }catch(Exception error){call.reject("Unable to save demo export");}
    }

}

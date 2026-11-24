#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <esp_timer.h>
#include <time.h>
#include "StrictController.h"

const int NS_R=25, NS_Y=26, NS_G=27, EW_R=18, EW_Y=19, EW_G=21;
StrictController controller;
portMUX_TYPE controllerMux = portMUX_INITIALIZER_UNLOCKED;
String backend, deviceId, token, ssid, password, ca, bootId;
uint64_t nowMs() { return uint64_t(esp_timer_get_time()) / 1000; }
const char* phaseName(Phase phase) {
  switch(phase) { case Phase::Green:return "green";case Phase::Yellow:return "yellow";case Phase::Clearance:return "clearance";default:return "waiting"; }
}
void showLamps(Phase phase, bool redNS) {
  bool nsGreen=phase==Phase::Green && !redNS, ewGreen=phase==Phase::Green && redNS;
  bool nsYellow=phase==Phase::Yellow && !redNS, ewYellow=phase==Phase::Yellow && redNS;
  // Remove both permissive outputs before enabling the next movement.
  digitalWrite(NS_G,LOW);digitalWrite(EW_G,LOW);digitalWrite(NS_Y,LOW);digitalWrite(EW_Y,LOW);
  digitalWrite(NS_R,!(nsGreen||nsYellow));digitalWrite(EW_R,!(ewGreen||ewYellow));
  digitalWrite(NS_Y,nsYellow);digitalWrite(EW_Y,ewYellow);digitalWrite(NS_G,nsGreen);digitalWrite(EW_G,ewGreen);
}
void configure(const String& line) {
  StaticJsonDocument<8192> doc;
  if(deserializeJson(doc,line)) { Serial.println("Invalid JSON configuration.");return; }
  portENTER_CRITICAL(&controllerMux); bool idle=controller.phase==Phase::Waiting && !controller.active.id; if(idle)controller.networkFault(); portEXIT_CRITICAL(&controllerMux);
  if(!idle) { Serial.println("Configuration locked during an active phase. Retry while both directions are held red.");return; }
  String url=doc["server"]|"", id=doc["deviceId"]|"", key=doc["token"]|"", root=doc["ca"]|"";
  if((!url.startsWith("http://")&&!url.startsWith("https://")) || id.length()!=36 || key.length()!=64 || (url.startsWith("https://") && root.isEmpty())) { Serial.println("Supply server URL, deviceId, token; HTTPS also needs a CA certificate in ca.");return; }
  while(url.endsWith("/"))url.remove(url.length()-1);
  Preferences prefs;prefs.begin("traffic",false);
  prefs.putString("server",url);prefs.putString("id",id);prefs.putString("token",key);
  prefs.putString("ssid",doc["ssid"]|"Wokwi-GUEST");prefs.putString("password",doc["password"]|"");prefs.putString("ca",root);prefs.end();
  Serial.println("Connection saved. Restarting while all-red. Credentials are not printed.");delay(50);ESP.restart();
}
void communication(void*) {
  String line; uint64_t lastPoll=0,lastWifiAttempt=0;bool ntpStarted=false;
  for(;;) {
    while(Serial.available()) {
      char ch=Serial.read();
      if(ch=='\n') { if(line.length())configure(line);line=""; }
      else if(ch!='\r') { if(line.length()<8000)line+=ch;else {line="";Serial.println("Configuration line too long.");} }
    }
    uint64_t now=nowMs();
    if(backend.isEmpty()) { vTaskDelay(pdMS_TO_TICKS(20));continue; }
    if(WiFi.status()!=WL_CONNECTED) {
      portENTER_CRITICAL(&controllerMux);controller.networkFault();portEXIT_CRITICAL(&controllerMux);
      if(now-lastWifiAttempt>=5000) { lastWifiAttempt=now;WiFi.begin(ssid.c_str(),password.c_str()); }
      vTaskDelay(pdMS_TO_TICKS(20));continue;
    }
    if(backend.startsWith("https://")) {
      if(!ntpStarted){configTime(0,0,"pool.ntp.org","time.nist.gov");ntpStarted=true;}
      if(time(nullptr)<1700000000){vTaskDelay(pdMS_TO_TICKS(50));continue;}
    }
    if(now-lastPoll<1000) { vTaskDelay(pdMS_TO_TICKS(20));continue; } lastPoll=now;
    StaticJsonDocument<1024> report; report["deviceId"]=deviceId;report["bootId"]=bootId;
    portENTER_CRITICAL(&controllerMux);
    report["phase"]=phaseName(controller.phase);report["completedId"]=controller.completedId;report["remainingMs"]=controller.remaining(nowMs());
    if(controller.active.id)report["activeId"]=controller.active.id;else report["activeId"]=nullptr;
    portEXIT_CRITICAL(&controllerMux);
    String payload;serializeJson(report,payload);
    HTTPClient http;WiFiClient plain;WiFiClientSecure secure;
    if(backend.startsWith("https://")) { secure.setCACert(ca.c_str());http.begin(secure,backend+"/api/embedded/exchange"); }
    else http.begin(plain,backend+"/api/embedded/exchange");
    http.setConnectTimeout(1500);http.setTimeout(2000);http.addHeader("Content-Type","application/json");http.addHeader("Authorization","Bearer "+token);
    int status=http.POST(payload);
    StaticJsonDocument<1024> response;
    bool valid=status==200 && !deserializeJson(response,http.getString()) && response["protocol"]==1;
    if(valid && !response["next"].isNull()) {
      JsonObject next=response["next"];String axis=next["redAxis"]|"";
      if((axis=="north_south"||axis=="east_west") && next["yellowSeconds"]==3 && next["clearanceSeconds"]==2) {
        Command command{next["id"].as<uint32_t>(),axis=="north_south",next["redSeconds"].as<uint32_t>()};
        portENTER_CRITICAL(&controllerMux);controller.offer(command,nowMs());portEXIT_CRITICAL(&controllerMux);
      }
    } else if(!valid) { portENTER_CRITICAL(&controllerMux);controller.networkFault();portEXIT_CRITICAL(&controllerMux);Serial.printf("Server unavailable/rejected (%d); active deadline retained.\n",status); }
    http.end();vTaskDelay(pdMS_TO_TICKS(20));
  }
}
void setup() {
  Serial.begin(115200);Serial.setTimeout(10);
  for(int pin:{NS_R,NS_Y,NS_G,EW_R,EW_Y,EW_G})pinMode(pin,OUTPUT);
  showLamps(Phase::Waiting,true);controller.begin(nowMs());
  char boot[33];snprintf(boot,sizeof(boot),"%08x%08x%08x%08x",esp_random(),esp_random(),esp_random(),esp_random());bootId=boot;
  Preferences prefs;prefs.begin("traffic",true);backend=prefs.getString("server","");deviceId=prefs.getString("id","");token=prefs.getString("token","");ssid=prefs.getString("ssid","Wokwi-GUEST");password=prefs.getString("password","");ca=prefs.getString("ca","");prefs.end();
  WiFi.mode(WIFI_STA);if(backend.length())WiFi.begin(ssid.c_str(),password.c_str());
  Serial.println("Wokwi traffic controller. Paste one-line connection JSON into Serial (newline). Timings come only from the server queue.");
  xTaskCreatePinnedToCore(communication,"network",16384,nullptr,1,nullptr,0);
}
void loop() {
  static Phase previous=Phase::Clearance;static uint32_t previousId=0;
  portENTER_CRITICAL(&controllerMux);controller.tick(nowMs());Phase phase=controller.phase;bool axis=controller.active.redNorthSouth;uint32_t id=controller.active.id;portEXIT_CRITICAL(&controllerMux);
  if(phase!=previous || id!=previousId) {showLamps(phase,axis);Serial.printf("Phase=%s command=%u (local strict timer)\n",phaseName(phase),id);previous=phase;previousId=id;}
  delay(1);
}

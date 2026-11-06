using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// The event IDs are from the installed mstscax.dll type library.
[ComVisible(true), Guid("336d5562-efa8-482e-8cb3-c5c0fc7a7db6"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface OpenShellRdpEvents {
    [DispId(1)] void OnConnecting();
    [DispId(2)] void OnConnected();
    [DispId(3)] void OnLoginComplete();
    [DispId(4)] void OnDisconnected(int reason);
    [DispId(10)] void OnFatalError(int code);
    [DispId(15)] void OnConfirmClose([In, Out] ref bool allow);
    [DispId(22)] void OnLogonError(int code);
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class OpenShellRdpSink : OpenShellRdpEvents {
    readonly Action<string,int?> report;
    public bool LoggedIn, Closing, Fatal;
    public OpenShellRdpSink(Action<string,int?> report) { this.report=report; }
    public void OnConnecting() { report("starting",null); }
    public void OnConnected() { report("launched",null); }
    public void OnLoginComplete() { LoggedIn=true; report("connected",null); }
    public void OnDisconnected(int reason) { report(Fatal ? "failed" : Closing ? "closed" : !LoggedIn ? "failed" : "disconnected",reason); }
    public void OnFatalError(int code) { Fatal=true; report("failed",code); }
    public void OnConfirmClose(ref bool allow) { allow=true; }
    // OnLogonError includes continuation/dialog notifications; zero means bad credentials.
    public void OnLogonError(int code) { if(code==3 || (code<=-2 && code>=-7)) return;Fatal=true;report("failed",code); }
}

public sealed class OpenShellRdpControl : AxHost {
    ConnectionPointCookie cookie;
    public readonly OpenShellRdpSink Sink;
    public OpenShellRdpControl(Action<string,int?> report) : base("A0C63C30-F08D-4AB4-907C-34905D770C7D") { Sink=new OpenShellRdpSink(report); }
    public dynamic Client { get { return GetOcx(); } }
    protected override void CreateSink() { base.CreateSink();cookie=new ConnectionPointCookie(GetOcx(),Sink,typeof(OpenShellRdpEvents)); }
    protected override void DetachSink() { if(cookie!=null) {cookie.Disconnect();cookie=null;}base.DetachSink(); }
}

public static class OpenShellRdpHost {
    static readonly JavaScriptSerializer json=new JavaScriptSerializer();
    static void Report(string state,int? code) { Console.Out.WriteLine(json.Serialize(new {state=state,code=code}));Console.Out.Flush(); }
    static int Number(Dictionary<string,object> config,string key,int fallback) { object value; return config.TryGetValue(key,out value) && value!=null ? Convert.ToInt32(value) : fallback; }
    static bool Flag(Dictionary<string,object> config,string key,bool fallback) { object value; return config.TryGetValue(key,out value) && value!=null ? Convert.ToBoolean(value) : fallback; }

    public static void Run(string input) {
        var message=json.Deserialize<Dictionary<string,object>>(input);
        input=null;
        var config=(Dictionary<string,object>)message["config"];
        string password=message["password"] as string;
        message["password"]=null;
        Application.EnableVisualStyles();
        using(var form=new Form()) {
        bool terminalReported=false;
        using(var control=new OpenShellRdpControl(delegate(string state,int? code) {
            if(terminalReported) return;
            Report(state,code);
            if(state=="failed" || state=="disconnected" || state=="closed") {
                terminalReported=true;
                if(state!="closed") form.BeginInvoke(new Action(form.Close));
            }
        })) {
            form.Text="OpenShell — "+(string)config["host"];
            form.ClientSize=new Size(Number(config,"width",1920),Number(config,"height",1080));
            control.Dock=DockStyle.Fill;form.Controls.Add(control);
            if(Flag(config,"hidden_test",false)) {form.Opacity=0;form.ShowInTaskbar=false;}
            if(Flag(config,"fullscreen",false)) {form.FormBorderStyle=FormBorderStyle.None;form.WindowState=FormWindowState.Maximized;}
            form.Shown+=delegate {
                try {
                    dynamic client=control.Client;
                    client.Server=(string)config["host"];client.UserName=(string)config["username"];
                    object domain; if(config.TryGetValue("domain",out domain) && domain!=null) client.Domain=(string)domain;
                    client.DesktopWidth=Number(config,"width",1920);client.DesktopHeight=Number(config,"height",1080);
                    dynamic settings=client.AdvancedSettings9;
                    settings.RDPPort=Number(config,"port",3389);
                    settings.EnableCredSspSupport=true;
                    settings.AuthenticationLevel=2;
                    settings.EnableAutoReconnect=false;
                    settings.singleConnectionTimeout=10;
                    settings.overallConnectionTimeout=15;
                    settings.SmartSizing=true;
                    settings.RedirectClipboard=Flag(config,"redirect_clipboard",true);
                    settings.RedirectDrives=Flag(config,"drivestoredirect",false);
                    settings.RedirectPrinters=Flag(config,"redirect_printers",false);
                    settings.ConnectToAdministerServer=Flag(config,"admin_session",false);
                    object audio;config.TryGetValue("redirect_audio",out audio);
                    settings.AudioRedirectionMode=(audio as string)=="remote" ? 1 : (audio as string)=="none" ? 2 : 0;
                    if(!String.IsNullOrEmpty(password)) settings.ClearTextPassword=password;
                    password=null;
                    Report("launched",null);
                    client.Connect();
                } catch(Exception error) { password=null;control.Sink.OnFatalError(error.HResult); }
            };
            form.FormClosing+=delegate {
                control.Sink.Closing=true;
                try { dynamic client=control.Client;if(client.Connected!=0) client.Disconnect(); } catch { }
                if(!terminalReported) Report("closed",null);
            };
            Application.Run(form);
        }
        }
    }

    // Checks the real COM activation and the distinction between transport and authenticated login.
    public static void SelfCheck() {
        var states=new List<string>();var sink=new OpenShellRdpSink(delegate(string state,int? code) {states.Add(state);});
        sink.OnConnecting();sink.OnConnected();if(states.Contains("connected")) throw new Exception("Transport reported authenticated login");
        sink.OnLoginComplete();if(states[states.Count-1]!="connected") throw new Exception("Login event missing");
        sink.OnFatalError(1);sink.OnDisconnected(1);if(states[states.Count-1]!="failed") throw new Exception("Fatal result lost");
        sink.Fatal=false;sink.Closing=true;sink.OnDisconnected(1);if(states[states.Count-1]!="closed") throw new Exception("Close event missing");
        int count=states.Count;sink.OnLogonError(-2);sink.OnLogonError(3);if(states.Count!=count) throw new Exception("Logon progress reported failure");
        sink.OnLogonError(0);if(states.Count!=count+1 || states[states.Count-1]!="failed") throw new Exception("Bad password event missing");
        using(var form=new Form()) using(var control=new OpenShellRdpControl(delegate(string state,int? code) {})) {
            form.Opacity=0;form.ShowInTaskbar=false;form.Controls.Add(control);form.Show();
            dynamic client=control.Client;client.AdvancedSettings9.AuthenticationLevel=2;
            form.Close();
        }
    }
}

// Writes a FAKE Outlook .pst from a JSON-lines spec, for Casefile's tests and measurements only
// (BIGDATA-3B). It is built and run by tools/fake-corpus/src/pst-writer.ts, which fetches the PST
// library it needs (PSTFileFormat by ROM Knowledgeware, LGPL-3.0-or-later, at a pinned commit) and
// the empty starting file (Empty.pst from microsoft/outlook-pst-rs, MIT, at a pinned commit, SHA-256
// checked) into a cache folder OUTSIDE the repository, and compiles this file with the C# compiler of
// the .NET Framework that ships with Windows. Nothing here is part of Casefile's runtime.
//
//   PstWriter.exe <template.pst> <spec.jsonl> <out.pst> <map.tsv>
//
// Spec lines (UTF-8 JSON, one object per line):
//   {"t":"store","name":"...","passwordCrc":123}        optional, first line
//   {"t":"msg","key":"k","folder":["Inbox","Projects"],"subject":"...","body":"...",
//    "from":{"n":"Name","e":"a@b"},"to":[...],"cc":[...],"bcc":[...],"date":"2021-03-04T10:11:12Z",
//    "messageId":"<id@x>" or null,"headers":"transport headers" or null,
//    "atts":[{"name":"a.pdf","mime":"application/pdf","b64":"..."}, {"name":"x.pdf","mime":"...","reference":"\\\\server\\x.pdf"}],
//    "emb":[{"subject":"...","body":"...","from":{...},"to":[...],"date":"...","messageId":"..."}]}
// map.tsv gets one line per message: key <TAB> node id (hex) <TAB> folder path joined with '/'.
//
// C# 5 only (the compiler that ships with Windows): no string interpolation, no ?. operator.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using PSTFileFormat;

class PstWriter
{
    const int MessagesPerCommit = 200;
    const PropertyID PidTagTransportMessageHeaders = (PropertyID)0x007D;
    const PropertyID PidTagDisplayCc = (PropertyID)0x0E03;
    const PropertyID PidTagDisplayBcc = (PropertyID)0x0E02;
    const PropertyID PidTagSubject = (PropertyID)0x0037;
    const PropertyID PidTagPstPassword = (PropertyID)0x67FF;

    static PSTFile file;
    static Dictionary<string, NodeID> folderIds = new Dictionary<string, NodeID>();
    static Dictionary<string, PSTFolder> open = new Dictionary<string, PSTFolder>();

    static int Main(string[] args)
    {
        if (args.Length != 4)
        {
            Console.Error.WriteLine("usage: PstWriter.exe <template.pst> <spec.jsonl> <out.pst> <map.tsv>");
            return 2;
        }
        if (File.Exists(args[2])) { Console.Error.WriteLine("refusing to overwrite " + args[2]); return 2; }
        File.Copy(args[0], args[2], false);
        file = new PSTFile(args[2], FileAccess.ReadWrite, WriterCompatibilityMode.Outlook2007SP2);
        JavaScriptSerializer json = new JavaScriptSerializer();
        json.MaxJsonLength = int.MaxValue;
        int count = 0;
        file.BeginSavingChanges();
        // Pass 1: every folder the spec names, created before any message is written (a folder object
        // goes stale when a sub-folder is created through another instance of it).
        using (StreamReader spec = new StreamReader(args[1], new UTF8Encoding(false)))
        {
            string line;
            while ((line = spec.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                Dictionary<string, object> rec = (Dictionary<string, object>)json.DeserializeObject(line);
                if ((string)rec["t"] == "msg") CreateFolder(Strings(rec["folder"]));
            }
        }
        file.CommitChanges();
        // Pass 2: the store's properties and the messages.
        using (StreamReader spec = new StreamReader(args[1], new UTF8Encoding(false)))
        using (StreamWriter map = new StreamWriter(args[3], false, new UTF8Encoding(false)))
        {
            string line;
            while ((line = spec.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                Dictionary<string, object> rec = (Dictionary<string, object>)json.DeserializeObject(line);
                string t = (string)rec["t"];
                if (t == "store") { WriteStore(rec); continue; }
                if (t != "msg") throw new Exception("unknown spec line type " + t);
                string[] folder = Strings(rec["folder"]);
                PSTFolder f = Folder(folder);
                NodeID nid = WriteMessage(f, rec);
                map.WriteLine((string)rec["key"] + "\t" + nid.Value.ToString("x8") + "\t" + string.Join("/", folder));
                count++;
                if (count % MessagesPerCommit == 0) Commit();
            }
        }
        foreach (PSTFolder f in open.Values) f.SaveChanges();
        open.Clear();
        file.EndSavingChanges();
        file.CloseFile();
        Console.WriteLine("wrote " + count + " messages to " + args[2] + " (" + new FileInfo(args[2]).Length + " bytes)");
        return 0;
    }

    static void Commit()
    {
        foreach (PSTFolder f in open.Values) f.SaveChanges();
        open.Clear();
        file.CommitChanges();
    }

    static void WriteStore(Dictionary<string, object> rec)
    {
        PSTNode store = file.GetNode(InternalNodeName.NID_MESSAGE_STORE);
        if (rec.ContainsKey("name") && rec["name"] != null) store.PC.SetStringProperty(PropertyID.PidTagDisplayName, (string)rec["name"]);
        if (rec.ContainsKey("passwordCrc") && rec["passwordCrc"] != null)
        {
            int crc = Convert.ToInt32(rec["passwordCrc"], CultureInfo.InvariantCulture);
            if (crc != 0) store.PC.SetInt32Property(PidTagPstPassword, crc);
        }
        store.SaveChanges();
    }

    /// Creates the folder at `path` under the top of the personal folders (and its parents) when missing.
    static void CreateFolder(string[] path)
    {
        PSTFolder parent = file.TopOfPersonalFolders;
        for (int i = 0; i < path.Length; i++)
        {
            string sub = string.Join("\u0001", path, 0, i + 1);
            NodeID known;
            PSTFolder next;
            if (folderIds.TryGetValue(sub, out known)) next = file.GetFolder(known);
            else
            {
                next = parent.FindChildFolder(path[i]);
                if (next == null) next = parent.CreateChildFolder(path[i], FolderItemTypeName.Note);
                folderIds[sub] = next.NodeID;
            }
            parent = next;
        }
    }

    /// The folder at `path` (created in pass 1), one open instance per folder until the next commit.
    static PSTFolder Folder(string[] path)
    {
        string key = string.Join("\u0001", path);
        PSTFolder f;
        if (open.TryGetValue(key, out f)) return f;
        f = file.GetFolder(folderIds[key]);
        open[key] = f;
        return f;
    }

    static NodeID WriteMessage(PSTFolder folder, Dictionary<string, object> rec)
    {
        Note note = Note.CreateNewNote(file, folder.NodeID);
        note.Subject = (string)rec["subject"];
        note.Body = (string)rec["body"];
        Dictionary<string, object> from = (Dictionary<string, object>)rec["from"];
        note.SenderName = (string)from["n"];
        note.SenderEmailAddress = (string)from["e"];
        note.SenderAddressType = "SMTP";
        note.SentRepresentingName = (string)from["n"];
        note.SentRepresentingEmailAddress = (string)from["e"];
        note.SentRepresentingAddressType = "SMTP";
        DateTime date = DateTime.Parse((string)rec["date"], CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
        note.ClientSubmitTime = date;
        note.MessageDeliveryTime = date;
        if (rec["messageId"] != null) note.PC.SetStringProperty(PropertyID.PidTagInternetMessageId, (string)rec["messageId"]);
        if (rec.ContainsKey("headers") && rec["headers"] != null) note.PC.SetStringProperty(PidTagTransportMessageHeaders, (string)rec["headers"]);

        List<string> display = new List<string>();
        int row = 0;
        foreach (int type in new int[] { 1, 2, 3 })
        {
            string field = type == 1 ? "to" : type == 2 ? "cc" : "bcc";
            List<string> names = new List<string>();
            foreach (object o in (IEnumerable)rec[field])
            {
                Dictionary<string, object> r = (Dictionary<string, object>)o;
                note.AddRecipient(new MessageRecipient((string)r["n"], (string)r["e"], false));
                note.RecipientsTable.SetInt32Property(row, PropertyID.PidTagRecipientType, type);
                names.Add((string)r["n"]);
                row++;
            }
            display.Add(string.Join("; ", names));
        }
        note.DisplayTo = display[0];
        if (display[1].Length > 0) note.PC.SetStringProperty(PidTagDisplayCc, display[1]);
        if (display[2].Length > 0) note.PC.SetStringProperty(PidTagDisplayBcc, display[2]);

        note.CreateSubnodeBTreeIfNotExist();
        foreach (object o in (IEnumerable)rec["atts"])
        {
            Dictionary<string, object> a = (Dictionary<string, object>)o;
            if (a.ContainsKey("reference") && a["reference"] != null)
            {
                // Attached by reference (attach method 2): the PST holds only the file's path, no content.
                AttachmentObject rf = AttachmentObject.CreateNewAttachmentObject(file, note.SubnodeBTree);
                rf.PC.SetInt32Property(PropertyID.PidTagAttachMethod, 2);
                rf.PC.SetStringProperty(PropertyID.PidTagDisplayName, (string)a["name"]);
                rf.PC.SetStringProperty(PropertyID.PidTagAttachLongFilename, (string)a["name"]);
                rf.PC.SetStringProperty(PropertyID.PidTagAttachLongPathname, (string)a["reference"]);
                rf.PC.SetStringProperty(PropertyID.PidTagAttachMimeTag, (string)a["mime"]);
                rf.PC.SetInt32Property(PropertyID.PidTagAttachSize, 0);
                rf.SaveChanges(note.SubnodeBTree);
                note.AddAttachment(rf);
                continue;
            }
            byte[] data = Convert.FromBase64String((string)a["b64"]);
            AttachmentObject att = AttachmentObject.CreateNewAttachmentObject(file, note.SubnodeBTree);
            string name = (string)a["name"];
            att.PC.SetInt32Property(PropertyID.PidTagAttachMethod, 1);
            att.PC.SetStringProperty(PropertyID.PidTagDisplayName, name);
            att.PC.SetStringProperty(PropertyID.PidTagAttachFilename, name);
            att.PC.SetStringProperty(PropertyID.PidTagAttachLongFilename, name);
            att.PC.SetStringProperty(PropertyID.PidTagAttachMimeTag, (string)a["mime"]);
            att.PC.SetBytesProperty(PropertyID.PidTagAttachData, data);
            att.PC.SetInt32Property(PropertyID.PidTagAttachSize, data.Length);
            att.SaveChanges(note.SubnodeBTree);
            note.AddAttachment(att);
        }
        foreach (object o in (IEnumerable)rec["emb"])
        {
            Dictionary<string, object> e = (Dictionary<string, object>)o;
            AttachmentObject emb = AttachmentObject.CreateNewAttachmentObject(file, note.SubnodeBTree);
            emb.PC.SetInt32Property(PropertyID.PidTagAttachMethod, 5);
            emb.PC.SetStringProperty(PropertyID.PidTagDisplayName, (string)e["subject"]);
            emb.CreateSubnodeBTreeIfNotExist();
            PropertyContext pc = PropertyContext.CreateNewPropertyContext(file);
            Dictionary<string, object> ef = (Dictionary<string, object>)e["from"];
            pc.SetStringProperty(PropertyID.PidTagMessageClass, "IPM.Note");
            pc.SetStringProperty(PidTagSubject, (string)e["subject"]);
            pc.SetStringProperty(PropertyID.PidTagBody, (string)e["body"]);
            pc.SetStringProperty(PropertyID.PidTagSenderName, (string)ef["n"]);
            pc.SetStringProperty(PropertyID.PidTagSenderEmailAddress, (string)ef["e"]);
            pc.SetStringProperty(PropertyID.PidTagSenderAddressType, "SMTP");
            List<string> embTo = new List<string>();
            foreach (object r in (IEnumerable)e["to"]) embTo.Add((string)((Dictionary<string, object>)r)["n"] + " <" + (string)((Dictionary<string, object>)r)["e"] + ">");
            pc.SetStringProperty(PropertyID.PidTagDisplayTo, string.Join("; ", embTo));
            if (e["messageId"] != null) pc.SetStringProperty(PropertyID.PidTagInternetMessageId, (string)e["messageId"]);
            pc.SetDateTimeProperty(PropertyID.PidTagClientSubmitTime, DateTime.Parse((string)e["date"], CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal));
            pc.SetInt32Property(PropertyID.PidTagMessageFlags, 1);
            pc.SaveChanges();
            NodeID inner = file.Header.AllocateNextNodeID(NodeTypeName.NID_TYPE_NORMAL_MESSAGE);
            emb.SubnodeBTree.InsertSubnodeEntry(inner, pc.DataTree, pc.SubnodeBTree);
            emb.PC.SetObjectProperty(PropertyID.PidTagAttachData, inner, pc.DataTree.TotalDataLength);
            emb.PC.SetInt32Property(PropertyID.PidTagAttachSize, pc.DataTree.TotalDataLength);
            emb.SaveChanges(note.SubnodeBTree);
            note.AddAttachment(emb);
        }
        note.SaveChanges();
        folder.AddMessage(note);
        return note.NodeID;
    }

    static string[] Strings(object o)
    {
        List<string> list = new List<string>();
        foreach (object x in (IEnumerable)o) list.Add((string)x);
        return list.ToArray();
    }
}

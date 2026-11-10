import UIKit
import Capacitor
import QuickLook

class CloudBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CloudFilesPlugin())
    }
}

private class DownloadRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@objc(CloudFilesPlugin)
class CloudFilesPlugin: CAPPlugin, CAPBridgedPlugin, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    let identifier = "CloudFilesPlugin"
    let jsName = "CloudFiles"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)]
    private var activeCall: CAPPluginCall?
    private var directory: URL?
    private var file: URL?

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.activeCall == nil else {
                call.reject("已有文件正在打开，请关闭当前面板后重试。")
                return
            }
            guard let key = call.getString("key"), !key.isEmpty,
                  let suppliedName = call.getString("name"),
                  let token = call.getString("token"), !token.isEmpty,
                  let mode = call.getString("mode"), ["share", "preview"].contains(mode),
                  let origin = self.getConfig().getString("backendOrigin"),
                  var components = URLComponents(string: origin),
                  ["http", "https"].contains(components.scheme ?? ""),
                  components.host != nil, components.user == nil, components.password == nil,
                  components.query == nil, components.fragment == nil else {
                call.reject("文件请求或后端地址无效。")
                return
            }
            let name = (suppliedName as NSString).lastPathComponent
            guard !name.isEmpty, name != ".", name != ".." else {
                call.reject("文件名无效。")
                return
            }
            guard let presenter = self.bridge?.viewController, presenter.presentedViewController == nil else {
                call.reject("请关闭当前面板后重试。")
                return
            }
            components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            components.path = "/" + (components.path.isEmpty ? "" : components.path + "/") + "api/files/download"
            components.queryItems = [URLQueryItem(name: "key", value: key)]
            components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
            guard let url = components.url else {
                call.reject("后端地址无效。")
                return
            }
            self.activeCall = call
            var request = URLRequest(url: url)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let session = URLSession(configuration: .ephemeral, delegate: DownloadRedirectBlocker(), delegateQueue: nil)
            session.downloadTask(with: request) { temporary, response, error in
                defer { session.finishTasksAndInvalidate() }
                if let error = error {
                    DispatchQueue.main.async { self.finish(error.localizedDescription) }
                    return
                }
                guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                      let temporary = temporary else {
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    DispatchQueue.main.async { self.finish("文件读取失败（\(status)）。") }
                    return
                }
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                let file = directory.appendingPathComponent(name)
                do {
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try FileManager.default.moveItem(at: temporary, to: file)
                } catch {
                    try? FileManager.default.removeItem(at: directory)
                    DispatchQueue.main.async { self.finish("无法保存临时文件：\(error.localizedDescription)") }
                    return
                }
                DispatchQueue.main.async {
                    self.directory = directory
                    self.file = file
                    guard presenter.presentedViewController == nil else {
                        self.finish("请关闭当前面板后重试。")
                        return
                    }
                    if mode == "preview" {
                        guard QLPreviewController.canPreview(file as NSURL) else {
                            self.finish("系统无法预览此文件，请下载后打开。")
                            return
                        }
                        let preview = QLPreviewController()
                        preview.dataSource = self
                        preview.delegate = self
                        presenter.present(preview, animated: true)
                    } else {
                        let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                        activity.popoverPresentationController?.sourceView = presenter.view
                        activity.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
                        activity.completionWithItemsHandler = { _, _, _, error in
                            self.finish(error?.localizedDescription)
                        }
                        presenter.present(activity, animated: true)
                    }
                }
            }.resume()
        }
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { file == nil ? 0 : 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        return file! as NSURL
    }

    func previewControllerDidDismiss(_ controller: QLPreviewController) { finish(nil) }

    private func finish(_ error: String?) {
        if let directory = directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil
        file = nil
        if let error = error { activeCall?.reject(error) }
        else { activeCall?.resolve() }
        activeCall = nil
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CloudBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

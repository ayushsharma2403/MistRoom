import Foundation
import Capacitor
import CoreBluetooth

/**
 * iOS Stub Plugin for MistBlePeripheral.
 * Note: iOS prohibits custom peripheral service advertisement with arbitrary manufacturer data in the background.
 * Advertising operates on best-effort basis while the app remains in the foreground.
 */
@objc(MistBlePeripheralPlugin)
public class MistBlePeripheralPlugin: CAPPlugin, CBPeripheralManagerDelegate {
    
    private var peripheralManager: CBPeripheralManager?
    private let SERVICE_UUID = CBUUID(string: "6e6d6973-7400-4d53-5400-000000000001")
    
    public override func load() {
        peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
    }
    
    @objc func startAdvertising(_ call: CAPPluginCall) {
        guard let pm = peripheralManager, pm.state == .poweredOn else {
            call.reject("Bluetooth not powered on")
            return
        }
        
        let advertisementData: [String: Any] = [
            CBAdvertisementDataServiceUUIDsKey: [SERVICE_UUID]
        ]
        
        pm.startAdvertising(advertisementData)
        call.resolve()
    }
    
    @objc func stopAdvertising(_ call: CAPPluginCall) {
        peripheralManager?.stopAdvertising()
        call.resolve()
    }
    
    @objc func notify(_ call: CAPPluginCall) {
        // Notification dispatch stub
        call.resolve()
    }
    
    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        // State updates handled here
    }
}
